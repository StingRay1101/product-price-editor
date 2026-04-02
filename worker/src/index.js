// ─── Helpers ─────────────────────────────────────────────────

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
  });
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
  const handle = url.searchParams.get("handle");
  const title = url.searchParams.get("title");
  if (!handle && !title) return json({ error: "handle or title parameter required" }, 400);

  try {
    // 1. Try direct handle filter
    if (handle) {
      const data = await lightspeed(
        env,
        "GET",
        `products?handle=${encodeURIComponent(handle)}&page_size=10`
      );
      const products = data.data || data.products || [];
      const match = products.find((p) => p.handle === handle);
      if (match) return json({ found: true, product: match });
    }

    // 2. Fallback: search by product name
    const searchTerm = title || handle;
    const search = await lightspeed(
      env,
      "GET",
      `search?type=products&q=${encodeURIComponent(searchTerm)}&page_size=20`
    );
    const searchResults = search.data || [];

    // Try exact name match first, then partial
    const exactMatch = searchResults.find(
      (p) => p.name?.toLowerCase() === title?.toLowerCase()
    );
    if (exactMatch) return json({ found: true, product: exactMatch });

    // Try matching by handle
    if (handle) {
      const handleMatch = searchResults.find((p) => p.handle === handle);
      if (handleMatch) return json({ found: true, product: handleMatch });
    }

    // Return first result if the search term is specific enough
    if (searchResults.length === 1) {
      return json({ found: true, product: searchResults[0] });
    }

    // Return all candidates so the user can see what's available
    return json({
      found: false,
      product: null,
      candidates: searchResults.slice(0, 5).map((p) => ({
        id: p.id,
        name: p.name,
        handle: p.handle,
        sku: p.sku,
      })),
    });
  } catch (err) {
    return json({ found: false, product: null, error: err.message });
  }
}

async function handleUpdatePrice(request, env) {
  const body = await request.json();
  const { shopifyVariantId, handle, price, compareAtPrice, lightspeedProductId } = body;

  if (!shopifyVariantId || !price) {
    return json({ error: "shopifyVariantId and price are required" }, 400);
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

  // Look up by handle if no ID was provided
  if (!lsId && handle) {
    try {
      const data = await lightspeed(
        env,
        "GET",
        `products?handle=${encodeURIComponent(handle)}&page_size=5`
      );
      const products = data.data || data.products || [];
      const match = products.find((p) => p.handle === handle);
      if (match) lsId = match.id;
    } catch (err) {
      errors.push({ platform: "Lightspeed", error: `Lookup failed: ${err.message}` });
    }
  }

  if (lsId) {
    try {
      const data = await lightspeed(env, "PUT", `products/${lsId}`, {
        id: lsId,
        retail_price: parseFloat(price),
      });
      results.lightspeed = { success: true, product: data.data || data };
    } catch (err) {
      errors.push({ platform: "Lightspeed", error: err.message });
    }
  } else if (!errors.some((e) => e.platform === "Lightspeed")) {
    errors.push({
      platform: "Lightspeed",
      error: `No product found for handle: ${handle}`,
    });
  }

  return json({ results, errors });
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
    const token = (request.headers.get("Authorization") || "").replace(
      "Bearer ",
      ""
    );
    if (token !== env.API_KEY) {
      return json({ error: "Unauthorized" }, 401);
    }

    try {
      if (url.pathname === "/api/products" && request.method === "GET") {
        return await handleSearch(url, env);
      }
      if (url.pathname === "/api/lightspeed-product" && request.method === "GET") {
        return await handleLightspeedLookup(url, env);
      }
      if (url.pathname === "/api/update-price" && request.method === "POST") {
        return await handleUpdatePrice(request, env);
      }
      return json({ error: "Not found" }, 404);
    } catch (err) {
      return json({ error: err.message }, 500);
    }
  },
};
