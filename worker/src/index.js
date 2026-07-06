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
  const bearerToken = (request.headers.get("Authorization") || "").replace("Bearer ", "");
  const portalPassword = request.headers.get("X-Portal-Password") || "";
  const apiKey = env.API_KEY || "";
  const configuredPortalPassword = env.PORTAL_PASSWORD || "";
  if (apiKey && bearerToken === apiKey) return true;
  if (configuredPortalPassword && portalPassword === configuredPortalPassword) return true;
  if (!configuredPortalPassword && apiKey && portalPassword === apiKey) return true;
  return false;
}

let shopifyTokenCache = { token: null, expiresAt: 0 };
let shopifyProductCache = { products: null, expiresAt: 0, inFlight: null };

async function getShopifyToken(env) {
  if (shopifyTokenCache.token && Date.now() < shopifyTokenCache.expiresAt - 300000) {
    return shopifyTokenCache.token;
  }
  const res = await fetch(`https://${env.SHOPIFY_STORE}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `grant_type=client_credentials&client_id=${env.SHOPIFY_CLIENT_ID}&client_secret=${env.SHOPIFY_CLIENT_SECRET}`,
  });
  if (!res.ok) { const text = await res.text(); throw new Error(`Shopify OAuth ${res.status}: ${text}`); }
  const data = await res.json();
  shopifyTokenCache = { token: data.access_token, expiresAt: Date.now() + data.expires_in * 1000 };
  return data.access_token;
}

async function shopifyRaw(env, method, endpointOrUrl, body) {
  const token = await getShopifyToken(env);
  const url = endpointOrUrl.startsWith("http")
    ? endpointOrUrl
    : `https://${env.SHOPIFY_STORE}/admin/api/2024-10/${endpointOrUrl}`;
  const res = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": token },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) { const text = await res.text(); throw new Error(`Shopify ${res.status}: ${text}`); }
  return res;
}

async function shopify(env, method, endpoint, body) {
  return (await shopifyRaw(env, method, endpoint, body)).json();
}

async function lightspeed(env, method, endpoint, body) {
  const base = env.LIGHTSPEED_URL.replace(/\/+$/, "");
  const res = await fetch(`${base}/api/2.0/${endpoint}`, {
    method,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.LIGHTSPEED_TOKEN}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) { const text = await res.text(); throw new Error(`Lightspeed ${res.status}: ${text}`); }
  return res.json();
}

async function updateLightspeedProductPrice(env, productId, price) {
  const numericPrice = Number(price);
  if (!Number.isFinite(numericPrice) || numericPrice < 0) throw new Error(`Invalid Lightspeed price: ${price}`);
  const base = env.LIGHTSPEED_URL.replace(/\/+$/, "");
  const res = await fetch(`${base}/api/2.1/products/${encodeURIComponent(productId)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.LIGHTSPEED_TOKEN}` },
    body: JSON.stringify({ details: { price_including_tax: numericPrice } }),
  });
  if (!res.ok) { const text = await res.text(); throw new Error(`Lightspeed ${res.status}: ${text}`); }
  return res.json();
}

function normalizeSearchValue(value) {
  return String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}
function compactSearchValue(value) { return normalizeSearchValue(value).replace(/\s+/g, ""); }
function getNextPageUrl(linkHeader) {
  if (!linkHeader) return null;
  const match = linkHeader.match(/<([^>]+)>;\s*rel="next"/);
  return match ? match[1] : null;
}

// Keep only the fields we actually need, this reduces the KV payload size significantly
function trimProduct(p) {
  return {
    id: p.id,
    title: p.title,
    handle: p.handle,
    status: p.status,
    images: p.images?.length ? [{ src: p.images[0].src }] : [],
    variants: (p.variants || []).map(v => ({
      id: v.id,
      title: v.title,
      sku: v.sku || "",
      price: v.price,
      compare_at_price: v.compare_at_price || null,
    })),
  };
}

async function fetchAllShopifyProducts(env) {
  const products = [];
  let nextUrl = `https://${env.SHOPIFY_STORE}/admin/api/2024-10/products.json?limit=250&fields=id,title,handle,variants,images,status`;
  while (nextUrl) {
    const res = await shopifyRaw(env, "GET", nextUrl);
    const data = await res.json();
    (data.products || []).forEach(p => products.push(trimProduct(p)));
    nextUrl = getNextPageUrl(res.headers.get("Link"));
  }
  return products;
}

const KV_PRODUCT_KEY = "shopify_products_v1";
const KV_TTL_SECONDS = 1800; // 30 minutes

function getMemoryCache() {
  if (Array.isArray(shopifyProductCache.products) && Date.now() < shopifyProductCache.expiresAt) {
    return shopifyProductCache.products;
  }
  return null;
}

async function getKVCache(env) {
  if (!env.PRODUCT_CACHE) return null;
  try {
    const data = await env.PRODUCT_CACHE.get(KV_PRODUCT_KEY, { type: "json" });
    if (Array.isArray(data) && data.length > 0) {
      shopifyProductCache.products = data;
      shopifyProductCache.expiresAt = Date.now() + KV_TTL_SECONDS * 1000;
      return data;
    }
  } catch (_) {}
  return null;
}

async function buildAndStoreCache(env) {
  const products = await fetchAllShopifyProducts(env);
  shopifyProductCache.products = products;
  shopifyProductCache.expiresAt = Date.now() + KV_TTL_SECONDS * 1000;
  if (env.PRODUCT_CACHE) {
    await env.PRODUCT_CACHE.put(KV_PRODUCT_KEY, JSON.stringify(products), { expirationTtl: KV_TTL_SECONDS });
  }
  return products;
}

function scoreProductMatch(product, nq, cq, tokens) {
  const title = normalizeSearchValue(product.title);
  const handle = normalizeSearchValue(product.handle);
  const vt = (product.variants || []).map(v => normalizeSearchValue(v.title));
  const skus = (product.variants || []).map(v => normalizeSearchValue(v.sku));
  const cskus = skus.map(s => s.replace(/\s+/g, ""));
  let score = 0;
  if (title === nq) score += 500;
  if (title.startsWith(nq)) score += 260;
  if (title.includes(nq)) score += 180;
  if (handle.startsWith(nq)) score += 140;
  if (handle.includes(nq)) score += 100;
  if (cq) {
    if (cskus.some(s => s === cq)) score += 340;
    if (cskus.some(s => s.startsWith(cq))) score += 280;
    if (cskus.some(s => s.includes(cq))) score += 220;
  }
  if (vt.some(t => t.includes(nq))) score += 120;
  score += tokens.reduce((total, t) => {
    let s = 0;
    if (title.includes(t)) s += 24;
    if (handle.includes(t)) s += 16;
    if (vt.some(v => v.includes(t))) s += 12;
    if (cskus.some(sk => sk.includes(t))) s += 22;
    return total + s;
  }, 0);
  return score;
}

function searchProductsByQuery(products, query) {
  const nq = normalizeSearchValue(query);
  if (!nq) return [];
  const cq = compactSearchValue(query);
  const tokens = nq.split(/\s+/).filter(Boolean);
  return products.map(product => {
    const title = normalizeSearchValue(product.title);
    const handle = normalizeSearchValue(product.handle);
    const vt = (product.variants || []).map(v => normalizeSearchValue(v.title));
    const skus = (product.variants || []).map(v => compactSearchValue(v.sku));
    const byPhrase = title.includes(nq) || handle.includes(nq) || vt.some(t => t.includes(nq)) || (cq && skus.some(s => s.includes(cq)));
    const byTokens = tokens.length > 0 && tokens.every(t => title.includes(t) || handle.includes(t) || vt.some(v => v.includes(t)) || skus.some(s => s.includes(t)));
    if (!byPhrase && !byTokens) return null;
    return { product, score: scoreProductMatch(product, nq, cq, tokens) };
  }).filter(Boolean)
    .sort((a, b) => b.score !== a.score ? b.score - a.score : String(a.product.title || "").localeCompare(String(b.product.title || "")))
    .map(e => e.product);
}

async function handleSearch(url, env, ctx) {
  const search = url.searchParams.get("search") || "";
  const limit = Math.min(parseInt(url.searchParams.get("limit") || "50", 10), 250);
  const isSuggestion = url.searchParams.get("suggest") === "1";

  if (!search.trim()) {
    const data = await shopify(env, "GET", `products.json?limit=${limit}&fields=id,title,handle,variants,images,status`);
    return json((data.products || []).map(trimProduct));
  }

  // Always try memory then KV first (instant)
  const mem = getMemoryCache();
  if (mem) return json(searchProductsByQuery(mem, search).slice(0, limit));
  const kv = await getKVCache(env);
  if (kv) return json(searchProductsByQuery(kv, search).slice(0, limit));

  // Cache cold, so build and store the full catalogue now rather than only
  // searching the first page. This is a bit slower on the first request,
  // but every request after this one hits the warm cache instead.
  const allProducts = await buildAndStoreCache(env);
  return json(searchProductsByQuery(allProducts, search).slice(0, limit));
}

async function handleLightspeedLookup(url, env) {
  const shopifyProductId = url.searchParams.get("shopifyProductId");
  const title = url.searchParams.get("title");
  if (!shopifyProductId) return json({ error: "shopifyProductId parameter required" }, 400);
  try {
    const searchTerm = title || shopifyProductId;
    const search = await lightspeed(env, "GET", `search?type=products&q=${encodeURIComponent(searchTerm)}&page_size=50`);
    const matches = (search.data || []).filter(p => p.source_id === String(shopifyProductId));
    if (matches.length > 0) return json({ found: true, products: matches });
    const directSearch = await lightspeed(env, "GET", `products?source_id=${encodeURIComponent(shopifyProductId)}&page_size=50`);
    const directResults = directSearch.data || [];
    if (directResults.length > 0) return json({ found: true, products: directResults });
    return json({ found: false, products: [] });
  } catch (err) {
    return json({ found: false, products: [], error: err.message });
  }
}

async function handleUpdatePrice(request, env) {
  const body = await request.json();
  const { shopifyVariantId, handle, price, compareAtPrice, lightspeedProductId } = body;
  const numericPrice = Number(price);
  if (!shopifyVariantId || price === undefined || price === null || String(price).trim() === "" || !Number.isFinite(numericPrice) || numericPrice < 0) {
    return json({ error: "shopifyVariantId and a valid price are required" }, 400);
  }
  const results = { shopify: null, lightspeed: null };
  const errors = [];
  try {
    const data = await shopify(env, "PUT", `variants/${shopifyVariantId}.json`, {
      variant: { id: Number(shopifyVariantId), price: String(price), compare_at_price: compareAtPrice ? String(compareAtPrice) : null },
    });
    results.shopify = { success: true, variant: data.variant };
  } catch (err) { errors.push({ platform: "Shopify", error: err.message }); }
  let lsId = lightspeedProductId;
  if (!lsId && shopifyVariantId) {
    try {
      const searchData = await lightspeed(env, "GET", `search?type=products&q=${encodeURIComponent(handle || shopifyVariantId)}&page_size=50`);
      const match = (searchData.data || []).find(p => p.source_variant_id === String(shopifyVariantId));
      if (match) lsId = match.id;
    } catch (err) { errors.push({ platform: "Lightspeed", error: `Lookup failed: ${err.message}` }); }
  }
  if (lsId) {
    try {
      const data = await updateLightspeedProductPrice(env, lsId, numericPrice);
      results.lightspeed = { success: true, product: data.data || data.product || data };
    } catch (err) { errors.push({ platform: "Lightspeed", error: err.message }); }
  } else if (!errors.some(e => e.platform === "Lightspeed")) {
    errors.push({ platform: "Lightspeed", error: "No matching Lightspeed product found for this variant" });
  }
  return json({ results, errors });
}

export default {
  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    const url = new URL(request.url);
    if (url.pathname === "/api/health") return json({ status: "ok" });
    if (!isAuthorizedRequest(request, env)) return json({ error: "Unauthorized" }, 401);
    try {
      if (url.pathname === "/api/ping" && request.method === "GET") return json({ ok: true });
      if (url.pathname === "/api/products" && request.method === "GET") return await handleSearch(url, env, ctx);
      if (url.pathname === "/api/lightspeed-product" && request.method === "GET") return await handleLightspeedLookup(url, env);
      if (url.pathname === "/api/update-price" && request.method === "POST") return await handleUpdatePrice(request, env);
      if (url.pathname === "/api/cache-bust" && request.method === "POST") {
        shopifyProductCache = { products: null, expiresAt: 0, inFlight: null };
        if (env.PRODUCT_CACHE) await env.PRODUCT_CACHE.delete(KV_PRODUCT_KEY);
        return json({ ok: true, message: "Cache cleared, it will rebuild on the next search" });
      }
      return json({ error: "Not found" }, 404);
    } catch (err) {
      return json({ error: err.message }, 500);
    }
  },

  // Cron trigger, runs on a schedule to keep the KV cache fresh
  async scheduled(event, env, ctx) {
    ctx.waitUntil(buildAndStoreCache(env).catch(err => console.error("Cache build failed:", err.message)));
  },
};
