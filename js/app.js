// ─── State ───────────────────────────────────────────────────
const state = {
  products: new Map(),
  lightspeedCache: new Map(),
};

// ─── DOM ─────────────────────────────────────────────────────
const $ = (s) => document.querySelector(s);
const settingsPanel = $("#settings-panel");
const workerUrlInput = $("#worker-url");
const apiKeyInput = $("#api-key");
const setupNotice = $("#setup-notice");
const searchSection = $("#search-section");
const searchInput = $("#search-input");
const productsContainer = $("#products-container");
const toastContainer = $("#toast-container");

// ─── Init ────────────────────────────────────────────────────
function init() {
  workerUrlInput.value = localStorage.getItem("workerUrl") || "";
  apiKeyInput.value = localStorage.getItem("apiKey") || "";
  refreshUI();

  $("#settings-btn").addEventListener("click", () =>
    settingsPanel.classList.toggle("hidden")
  );
  $("#save-settings").addEventListener("click", saveSettings);
  $("#test-connection").addEventListener("click", testConnection);
  $("#search-btn").addEventListener("click", searchProducts);
  searchInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") searchProducts();
  });

  // Event delegation for product interactions
  productsContainer.addEventListener("click", onProductsClick);
}

function getConfig() {
  return {
    workerUrl: (localStorage.getItem("workerUrl") || "").replace(/\/+$/, ""),
    apiKey: localStorage.getItem("apiKey") || "",
  };
}

function refreshUI() {
  const { workerUrl, apiKey } = getConfig();
  if (workerUrl && apiKey) {
    setupNotice.classList.add("hidden");
    searchSection.classList.remove("hidden");
  } else {
    setupNotice.classList.remove("hidden");
    searchSection.classList.add("hidden");
  }
}

function saveSettings() {
  localStorage.setItem("workerUrl", workerUrlInput.value.replace(/\/+$/, ""));
  localStorage.setItem("apiKey", apiKeyInput.value);
  refreshUI();
  settingsPanel.classList.add("hidden");
  showToast("Settings saved", "success");
}

async function testConnection() {
  const btn = $("#test-connection");
  btn.textContent = "Testing...";
  btn.disabled = true;
  try {
    await apiFetch("/api/products?search=test&limit=1");
    showToast("Connection successful", "success");
  } catch (err) {
    showToast("Connection failed: " + err.message, "error");
  } finally {
    btn.textContent = "Test Connection";
    btn.disabled = false;
  }
}

// ─── API Client ──────────────────────────────────────────────
async function apiFetch(endpoint, options = {}) {
  const { workerUrl, apiKey } = getConfig();
  const res = await fetch(`${workerUrl}${endpoint}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
      ...(options.headers || {}),
    },
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `API error ${res.status}`);
  return data;
}

// ─── Product Search ──────────────────────────────────────────
async function searchProducts() {
  const query = searchInput.value.trim();
  productsContainer.innerHTML = '<div class="loading">Searching...</div>';

  try {
    const products = await apiFetch(
      `/api/products?search=${encodeURIComponent(query)}`
    );
    state.products.clear();
    products.forEach((p) => state.products.set(String(p.id), p));
    renderProducts(products);
  } catch (err) {
    productsContainer.innerHTML = `<div class="error-state">${esc(err.message)}</div>`;
  }
}

// ─── Render Products ─────────────────────────────────────────
function renderProducts(products) {
  if (!products.length) {
    productsContainer.innerHTML =
      '<div class="empty">No products found. Try a different search term.</div>';
    return;
  }

  productsContainer.innerHTML = products
    .map((p) => {
      const img = p.images?.[0]?.src;
      const imgHtml = img
        ? `<img src="${esc(img)}" alt="" class="product-thumb">`
        : '<div class="product-thumb placeholder"></div>';

      return `
      <div class="product-card" data-product-id="${esc(String(p.id))}" data-handle="${esc(p.handle)}">
        <div class="product-header">
          <div class="product-info">
            ${imgHtml}
            <div>
              <h3>${esc(p.title)}</h3>
              <span class="handle">${esc(p.handle)}</span>
              <span class="variant-count">${p.variants.length} variant${p.variants.length !== 1 ? "s" : ""}</span>
            </div>
          </div>
          <span class="expand-icon">&#9654;</span>
        </div>
        <div class="product-variants hidden" id="variants-${p.id}"></div>
      </div>`;
    })
    .join("");
}

// ─── Event Delegation ────────────────────────────────────────
function onProductsClick(e) {
  // Header click → expand/collapse
  const header = e.target.closest(".product-header");
  if (header) {
    const card = header.closest(".product-card");
    toggleProduct(card.dataset.productId);
    return;
  }

  // Save button click
  const saveBtn = e.target.closest(".btn-save");
  if (saveBtn) {
    saveVariant(saveBtn);
  }
}

// ─── Toggle Product ──────────────────────────────────────────
async function toggleProduct(productId) {
  const variantsDiv = document.getElementById(`variants-${productId}`);
  const card = variantsDiv.closest(".product-card");
  const icon = card.querySelector(".expand-icon");

  if (!variantsDiv.classList.contains("hidden")) {
    variantsDiv.classList.add("hidden");
    icon.classList.remove("open");
    return;
  }

  variantsDiv.classList.remove("hidden");
  icon.classList.add("open");

  // Already loaded
  if (variantsDiv.dataset.loaded === "true") return;

  variantsDiv.innerHTML =
    '<div class="variants-loading">Looking up Lightspeed product...</div>';

  const product = state.products.get(String(productId));
  if (!product) return;

  // Fetch Lightspeed matches by Shopify product ID
  let lsProducts = [];
  try {
    const data = await apiFetch(
      `/api/lightspeed-product?shopifyProductId=${product.id}&title=${encodeURIComponent(product.title)}`
    );
    if (data.found) {
      lsProducts = data.products || [];
    }
  } catch (err) {
    console.warn("Lightspeed lookup failed:", err.message);
  }

  renderVariants(product, lsProducts, variantsDiv);
  variantsDiv.dataset.loaded = "true";
}

// ─── Render Variants ─────────────────────────────────────────
function renderVariants(product, lsProducts, container) {
  const matchCount = lsProducts.length;
  const lsBadge = matchCount > 0
    ? `<span class="ls-badge found">Lightspeed linked (${matchCount} variant${matchCount !== 1 ? "s" : ""})</span>`
    : `<span class="ls-badge not-found">Lightspeed: no match found</span>`;

  const rows = product.variants
    .map((v) => {
      const variantLabel =
        v.title === "Default Title" ? "\u2014" : esc(v.title);

      // Find matching Lightspeed product by source_variant_id
      const lsMatch = lsProducts.find(
        (lp) => String(lp.source_variant_id) === String(v.id)
      );
      const lsPrice = lsMatch
        ? lsMatch.price_including_tax ?? lsMatch.price ?? null
        : null;
      const lsId = lsMatch ? lsMatch.id : "";
      const lsName = lsMatch ? lsMatch.variant_name || lsMatch.name : "";

      return `
      <tr data-variant-id="${esc(String(v.id))}">
        <td>${variantLabel}</td>
        <td>${esc(v.sku || "\u2014")}</td>
        <td class="current-price">$${esc(v.price)}</td>
        <td class="current-price">${v.compare_at_price ? "$" + esc(v.compare_at_price) : "\u2014"}</td>
        <td class="current-price">${lsPrice !== null ? "$" + esc(String(lsPrice)) : "\u2014"}</td>
        <td><input type="number" step="0.01" min="0" class="input-price" value="${esc(v.price)}"></td>
        <td><input type="number" step="0.01" min="0" class="input-compare" value="${esc(v.compare_at_price || "")}" placeholder="Optional"></td>
        <td>
          <button class="btn-save"
            data-variant-id="${esc(String(v.id))}"
            data-handle="${esc(product.title)}"
            data-ls-id="${esc(lsId)}">Save</button>
        </td>
        <td class="status-cell"></td>
      </tr>`;
    })
    .join("");

  container.innerHTML = `
    ${lsBadge}
    <table class="variants-table">
      <thead>
        <tr>
          <th>Variant</th>
          <th>SKU</th>
          <th>Shopify Price</th>
          <th>Compare At</th>
          <th>LS Price</th>
          <th>New Price</th>
          <th>New Compare At</th>
          <th></th>
          <th></th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>`;
}

// ─── Save Variant ────────────────────────────────────────────
async function saveVariant(btn) {
  const row = btn.closest("tr");
  const variantId = btn.dataset.variantId;
  const handle = btn.dataset.handle;
  const lsId = btn.dataset.lsId || null;

  const priceInput = row.querySelector(".input-price");
  const compareInput = row.querySelector(".input-compare");
  const statusCell = row.querySelector(".status-cell");

  const price = priceInput.value.trim();
  const compareAtPrice = compareInput.value.trim() || null;

  if (!price || isNaN(price) || parseFloat(price) < 0) {
    showToast("Enter a valid price", "error");
    return;
  }

  btn.disabled = true;
  btn.textContent = "Saving...";
  statusCell.innerHTML = "";

  try {
    const result = await apiFetch("/api/update-price", {
      method: "POST",
      body: JSON.stringify({
        shopifyVariantId: variantId,
        handle,
        price,
        compareAtPrice,
        lightspeedProductId: lsId,
      }),
    });

    let html = "";
    if (result.results.shopify?.success) {
      html += '<span class="status-dot success"></span>Shopify ';
    }
    if (result.results.lightspeed?.success) {
      html += '<span class="status-dot success"></span>LS ';
    }
    if (result.errors?.length) {
      result.errors.forEach((e) => {
        html += `<span class="status-dot error"></span>${esc(e.platform)} `;
        showToast(`${e.platform}: ${e.error}`, "error");
      });
    }
    statusCell.innerHTML = html;

    if (!result.errors?.length) {
      showToast("Prices updated", "success");
    }

    // Update displayed current prices
    const cells = row.querySelectorAll(".current-price");
    cells[0].textContent = `$${price}`;
    cells[1].textContent = compareAtPrice ? `$${compareAtPrice}` : "\u2014";
    if (result.results.lightspeed?.success) {
      cells[2].textContent = `$${price}`;
    }
  } catch (err) {
    statusCell.innerHTML = '<span class="status-dot error"></span>Failed';
    showToast(err.message, "error");
  } finally {
    btn.disabled = false;
    btn.textContent = "Save";
  }
}

// ─── Toast ───────────────────────────────────────────────────
function showToast(message, type = "info") {
  const el = document.createElement("div");
  el.className = `toast ${type}`;
  el.textContent = message;
  toastContainer.appendChild(el);
  setTimeout(() => el.remove(), 4000);
}

// ─── Util ────────────────────────────────────────────────────
function esc(str) {
  const d = document.createElement("div");
  d.textContent = str;
  return d.innerHTML;
}

// ─── Start ───────────────────────────────────────────────────
document.addEventListener("DOMContentLoaded", init);
