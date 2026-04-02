// ─── Helpers ─────────────────────────────────────────────────

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Portal-Password",
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
  });
}

function isAuthorizedRequest(request, env) {
  const bearerToken = (request.headers.get("Authorization") || "").replace(
    "Bearer ",
    ""
  );
  const portalPassword = request.headers.get("X-Portal-Password") || "";
  const apiKey = env.API_KEY || "";
  const configuredPortalPassword = env.PORTAL_PASSWORD || "";

  if (apiKey && bearerToken === apiKey) {
    return true;
  }

  if (configuredPortalPassword && portalPassword === configuredPortalPassword) {
    return true;
  }

  // Backward-compatible fallback so existing API_KEY setups can become the page password
  // before a dedicated PORTAL_PASSWORD secret is added.
  if (!configuredPortalPassword && apiKey && portalPassword === apiKey) {
    return true;
  }

  return false;
}

// Cache token in module scope (persists within same isolate)
let shopifyTokenCache = { token: null, expiresAt: 0 };

async function getShopifyToken(env) {
  // Return cached token if still valid (with 5-min buffer)
  if (shopifyTokenCache.token && Date.now() < shopifyTokenCache.expiresAt - 300000) {
    return shopifyTokenCache.token;
  }

  const res = await fetch(
    `https://${env.SHOPIFY_STORE}/admin/oauth/access_token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `grant_type=client_credentials&client_id=${env.SHOPIFY_CLIENT_ID}&client_secret=${env.SHOPIFY_CLIENT_SECRET}`,
    }
  );

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Shopify OAuth ${res.status}: ${text}`);
  }

  const data = await res.json();
  shopifyTokenCache = {
    token: data.access_token,
    expiresAt: Date.now() + data.expires_in * 1000,
  };
  return data.access_token;
}

async function shopify(env, method, endpoint, body) {
  const token = await getShopifyToken(env);
  const url = `https://${env.SHOPIFY_STORE}/admin/api/2024-10/${endpoint}`;
  const res = await fetch(url, {
    method,
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": token,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Shopify ${res.status}: ${text}`);
  }
  return res.json();
}

async function lightspeed(env, method, endpoint, body) {
  const base = env.LIGHTSPEED_URL.replace(/\/+$/, "");
  const url = `${base}/api/2.0/${endpoint}`;
  const res = await fetch(url, {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${env.LIGHTSPEED_TOKEN}`,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Lightspeed ${res.status}: ${text}`);
  }
  return res.json();
}

async function updateLightspeedProductPrice(env, productId, price) {
  const numericPrice = Number(price);
  if (!Number.isFinite(numericPrice) || numericPrice < 0) {
    throw new Error(`Invalid Lightspeed price: ${price}`);
  }

  const base = env.LIGHTSPEED_URL.replace(/\/+$/, "");
  const res = await fetch(
    `${base}/api/2.1/products/${encodeURIComponent(productId)}`,
    {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${env.LIGHTSPEED_TOKEN}`,
      },
      body: JSON.stringify({
        details: {
          price_including_tax: numericPrice,
        },
      }),
    }
  );

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Lightspeed ${res.status}: ${text}`);
  }

  return res.json();
}

// ─── Handlers ────────────────────────────────────────────────

async function handleSearch(url, env) {
  const search = url.searchParams.get("search") || "";
  const limit = Math.min(
    parseInt(url.searchParams.get("limit") || "50", 10),
    250
  );

  let endpoint = `products.json?limit=${limit}&fields=id,title,handle,variants,images,status`;
  if (search) {
    endpoint += `&title=${encodeURIComponent(search)}`;
  }

  const data = await shopify(env, "GET", endpoint);
  return json(data.products);
}

async function handleLightspeedLookup(url, env) {
  const shopifyProductId = url.searchParams.get("shopifyProductId");
  const title = url.searchParams.get("title");
  if (!shopifyProductId) return json({ error: "shopifyProductId parameter required" }, 400);

  try {
    // Search Lightspeed using the product title
    const searchTerm = title || shopifyProductId;
    const search = await lightspeed(
      env,
      "GET",
      `search?type=products&q=${encodeURIComponent(searchTerm)}&page_size=50`
    );
    const searchResults = search.data || [];

    // Match by Shopify source_id — this is the reliable link
    const matches = searchResults.filter(
      (p) => p.source_id === String(shopifyProductId)
    );

    if (matches.length > 0) {
      return json({ found: true, products: matches });
    }

    // If title search didn't find it, try fetching by source_id directly
    const directSearch = await lightspeed(
      env,
      "GET",
      `products?source_id=${encodeURIComponent(shopifyProductId)}&page_size=50`
    );
    const directResults = directSearch.data || [];

    if (directResults.length > 0) {
      return json({ found: true, products: directResults });
    }

    return json({ found: false, products: [] });
  } catch (err) {
    return json({ found: false, products: [], error: err.message });
  }
}

async function handleUpdatePrice(request, env) {
  const body = await request.json();
  const { shopifyVariantId, handle, price, compareAtPrice, lightspeedProductId } = body;

  const numericPrice = Number(price);
  if (
    !shopifyVariantId ||
    price === undefined ||
    price === null ||
    String(price).trim() === "" ||
    !Number.isFinite(numericPrice) ||
    numericPrice < 0
  ) {
    return json({ error: "shopifyVariantId and a valid price are required" }, 400);
  }

  const results = { shopify: null, lightspeed: null };
  const errors = [];

  // 1. Update Shopify variant price + compare_at_price
  try {
    const data = await shopify(env, "PUT", `variants/${shopifyVariantId}.json`, {
      variant: {
        id: Number(shopifyVariantId),
        price: String(price),
        compare_at_price: compareAtPrice ? String(compareAtPrice) : null,
      },
    });
    results.shopify = { success: true, variant: data.variant };
  } catch (err) {
    errors.push({ platform: "Shopify", error: err.message });
  }

  // 2. Update Lightspeed product price
  let lsId = lightspeedProductId;

  // Look up by Shopify variant ID if no Lightspeed ID provided
  if (!lsId && shopifyVariantId) {
    try {
      // Search by product title to find Lightspeed products linked to this Shopify product
      const searchData = await lightspeed(
        env,
        "GET",
        `search?type=products&q=${encodeURIComponent(handle || shopifyVariantId)}&page_size=50`
      );
      const products = searchData.data || [];
      const match = products.find(
        (p) => p.source_variant_id === String(shopifyVariantId)
      );
      if (match) lsId = match.id;
    } catch (err) {
      errors.push({ platform: "Lightspeed", error: `Lookup failed: ${err.message}` });
    }
  }

  if (lsId) {
    try {
      const data = await updateLightspeedProductPrice(env, lsId, numericPrice);
      results.lightspeed = { success: true, product: data.data || data.product || data };
    } catch (err) {
      errors.push({ platform: "Lightspeed", error: err.message });
    }
  } else if (!errors.some((e) => e.platform === "Lightspeed")) {
    errors.push({
      platform: "Lightspeed",
      error: "No matching Lightspeed product found for this variant",
    });
  }

  return json({ results, errors });
}

// ─── Debug ──────────────────────────────────────────────────

async function handleDebugLightspeed(url, env) {
  const results = {};
  const base = env.LIGHTSPEED_URL.replace(/\/+$/, "");
  const testId = url.searchParams.get("id") || "a1943af6-df6c-442a-ae68-b47a762d4cd2";
  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${env.LIGHTSPEED_TOKEN}`,
  };
  const body = JSON.stringify({ id: testId, retail_price: 129.95 });

  // Try every possible method/path combination
  const attempts = [
    { label: "PUT /api/2.0/products/{id}", method: "PUT", path: `/api/2.0/products/${testId}` },
    { label: "POST /api/2.0/products/{id}", method: "POST", path: `/api/2.0/products/${testId}` },
    { label: "PATCH /api/2.0/products/{id}", method: "PATCH", path: `/api/2.0/products/${testId}` },
    { label: "POST /api/2.0/products", method: "POST", path: `/api/2.0/products` },
    { label: "PUT /api/products", method: "PUT", path: `/api/products` },
    { label: "POST /api/products", method: "POST", path: `/api/products` },
    { label: "POST /api/1.0/products", method: "POST", path: `/api/1.0/products` },
  ];

  results.attempts = [];
  for (const attempt of attempts) {
    try {
      const res = await fetch(`${base}${attempt.path}`, {
        method: attempt.method,
        headers,
        body,
      });
      const responseBody = await res.text();
      results.attempts.push({
        label: attempt.label,
        status: res.status,
        response: responseBody.substring(0, 200),
      });
    } catch (err) {
      results.attempts.push({
        label: attempt.label,
        error: err.message,
      });
    }
  }

  return json(results);
}

// ─── Router ──────────────────────────────────────────────────

export default {
  async fetch(request, env) {
    // CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS });
    }

    const url = new URL(request.url);

    // Health check (no auth)
    if (url.pathname === "/api/health") {
      return json({ status: "ok" });
    }

    // Authenticate
    if (!isAuthorizedRequest(request, env)) {
      return json({ error: "Unauthorized" }, 401);
    }

    try {
      if (url.pathname === "/api/ping" && request.method === "GET") {
        return json({ ok: true });
      }
      if (url.pathname === "/api/products" && request.method === "GET") {
        return await handleSearch(url, env);
      }
      if (url.pathname === "/api/lightspeed-product" && request.method === "GET") {
        return await handleLightspeedLookup(url, env);
      }
      if (url.pathname === "/api/update-price" && request.method === "POST") {
        return await handleUpdatePrice(request, env);
      }
      if (url.pathname === "/api/debug-lightspeed" && request.method === "GET") {
        return await handleDebugLightspeed(url, env);
      }
      return json({ error: "Not found" }, 404);
    } catch (err) {
      return json({ error: err.message }, 500);
    }
  },
};
