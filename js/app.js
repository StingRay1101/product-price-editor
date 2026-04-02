const MAX_ATTEMPTS = 5;
const LOCKOUT_MINUTES = 30;

const state = {
  products: new Map(),
  lightspeedCache: new Map(),
  authenticated: false,
};

const $ = (selector) => document.querySelector(selector);

const dom = {
  loginScreen: $("#login-screen"),
  loginPassword: $("#login-password"),
  loginBtn: $("#login-btn"),
  loginError: $("#login-error"),
  loginSettingsToggle: $("#login-settings-toggle"),
  loginSettingsPanel: $("#login-settings-panel"),
  loginWorkerUrl: $("#login-worker-url"),
  saveLoginSettings: $("#save-login-settings"),
  appShell: $("#app-shell"),
  settingsPanel: $("#settings-panel"),
  settingsBtn: $("#settings-btn"),
  workerUrlInput: $("#worker-url"),
  saveSettingsBtn: $("#save-settings"),
  testConnectionBtn: $("#test-connection"),
  logoutBtn: $("#logout-btn"),
  setupNotice: $("#setup-notice"),
  searchSection: $("#search-section"),
  searchInput: $("#search-input"),
  searchBtn: $("#search-btn"),
  productsContainer: $("#products-container"),
  toastContainer: $("#toast-container"),
  searchStatus: $("#search-status"),
  connectionStatus: $("#connection-status"),
};

function init() {
  bindEvents();
  hydrateWorkerUrlInputs();
  applyLockoutState();
  bootSession();
}

function bindEvents() {
  dom.loginBtn.addEventListener("click", attemptLogin);
  dom.loginPassword.addEventListener("keydown", (event) => {
    if (event.key === "Enter") attemptLogin();
  });

  dom.loginSettingsToggle.addEventListener("click", () => {
    dom.loginSettingsPanel.classList.toggle("hidden");
  });

  dom.saveLoginSettings.addEventListener("click", () => {
    const workerUrl = saveWorkerUrl(dom.loginWorkerUrl.value);
    if (!workerUrl) {
      showLoginError("Add the Worker URL before continuing.");
      return;
    }
    showLoginError("");
    showToast("Connection saved", "success");
  });

  dom.settingsBtn.addEventListener("click", () => {
    dom.settingsPanel.classList.toggle("hidden");
  });

  dom.saveSettingsBtn.addEventListener("click", () => {
    const workerUrl = saveWorkerUrl(dom.workerUrlInput.value);
    if (!workerUrl) {
      showToast("Add a valid Worker URL", "error");
      return;
    }
    dom.settingsPanel.classList.add("hidden");
    showToast("Connection saved", "success");
  });

  dom.testConnectionBtn.addEventListener("click", testConnection);
  dom.logoutBtn.addEventListener("click", logout);
  dom.searchBtn.addEventListener("click", searchProducts);
  dom.searchInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") searchProducts();
  });

  dom.productsContainer.addEventListener("click", onProductsClick);
}

function normalizeWorkerUrl(value) {
  return (value || "").trim().replace(/\/+$/, "");
}

function getConfig() {
  return {
    workerUrl: normalizeWorkerUrl(localStorage.getItem("workerUrl") || ""),
    portalPassword: localStorage.getItem("portal_password") || "",
  };
}

function hydrateWorkerUrlInputs() {
  const { workerUrl } = getConfig();
  dom.workerUrlInput.value = workerUrl;
  dom.loginWorkerUrl.value = workerUrl;
}

function saveWorkerUrl(value) {
  const normalized = normalizeWorkerUrl(value);
  if (!normalized) {
    localStorage.removeItem("workerUrl");
  } else {
    localStorage.setItem("workerUrl", normalized);
  }
  hydrateWorkerUrlInputs();
  refreshShell();
  return normalized;
}

function refreshShell() {
  const { workerUrl } = getConfig();
  const hasWorkerUrl = Boolean(workerUrl);

  dom.setupNotice.classList.toggle("hidden", hasWorkerUrl);
  dom.searchSection.classList.toggle("hidden", !hasWorkerUrl || !state.authenticated);

  if (!hasWorkerUrl) {
    dom.connectionStatus.textContent = "Connection needed";
    return;
  }

  dom.connectionStatus.textContent = state.authenticated
    ? "Portal authenticated"
    : "Awaiting sign-in";
}

function showLoginError(message) {
  dom.loginError.textContent = message;
}

function setSearchStatus(message) {
  dom.searchStatus.textContent = message;
}

function checkLockout() {
  const lockoutUntil = Number(localStorage.getItem("lockout_until") || "0");
  if (lockoutUntil && Date.now() < lockoutUntil) {
    const minutesRemaining = Math.ceil((lockoutUntil - Date.now()) / 60000);
    return `Too many failed attempts. Try again in ${minutesRemaining} minute${minutesRemaining !== 1 ? "s" : ""}.`;
  }

  localStorage.removeItem("failed_attempts");
  localStorage.removeItem("lockout_until");
  return "";
}

function recordFailedAttempt() {
  const attempts = Number(localStorage.getItem("failed_attempts") || "0") + 1;
  localStorage.setItem("failed_attempts", String(attempts));

  if (attempts >= MAX_ATTEMPTS) {
    localStorage.setItem(
      "lockout_until",
      String(Date.now() + LOCKOUT_MINUTES * 60 * 1000)
    );
    return true;
  }

  return false;
}

function applyLockoutState() {
  const lockoutMessage = checkLockout();
  const locked = Boolean(lockoutMessage);
  dom.loginPassword.disabled = locked;
  dom.loginBtn.disabled = locked;
  showLoginError(lockoutMessage);
}

function showApp() {
  state.authenticated = true;
  dom.loginScreen.classList.add("hidden");
  dom.appShell.classList.remove("hidden");
  dom.settingsPanel.classList.add("hidden");
  refreshShell();
  requestAnimationFrame(() => dom.searchInput.focus());
}

function showLogin() {
  state.authenticated = false;
  dom.appShell.classList.add("hidden");
  dom.loginScreen.classList.remove("hidden");
  refreshShell();
}

async function parseApiResponse(response) {
  const text = await response.text();
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return { error: text || `API error ${response.status}` };
  }
}

function buildAuthHeaders(secret, extraHeaders = {}) {
  const headers = { ...extraHeaders };

  if (secret) {
    headers["X-Portal-Password"] = secret;
    headers.Authorization = `Bearer ${secret}`;
  }

  return headers;
}

async function pingWorker(password) {
  const { workerUrl } = getConfig();
  if (!workerUrl) {
    throw new Error("Add the Worker URL in connection settings first.");
  }

  const tryRequest = async (path) => {
    const response = await fetch(`${workerUrl}${path}`, {
      method: "GET",
      headers: buildAuthHeaders(password),
    });
    const data = await parseApiResponse(response);
    return { response, data };
  };

  let { response, data } = await tryRequest("/api/ping");

  if (response.status === 404 || response.status === 405) {
    ({ response, data } = await tryRequest("/api/products?limit=1"));
  }

  if (response.status === 401) {
    throw new Error("Incorrect portal password.");
  }
  if (!response.ok) {
    throw new Error(data.error || `API error ${response.status}`);
  }
  return data;
}

async function bootSession() {
  refreshShell();
  setSearchStatus("No products loaded");

  const { workerUrl, portalPassword } = getConfig();
  dom.loginSettingsPanel.classList.toggle("hidden", Boolean(workerUrl));
  if (!workerUrl || !portalPassword) {
    showLogin();
    return;
  }

  try {
    await pingWorker(portalPassword);
    showApp();
    showLoginError("");
  } catch (error) {
    localStorage.removeItem("portal_password");
    showLogin();
    showLoginError(
      error.message === "Incorrect portal password."
        ? "Saved password is no longer valid."
        : error.message
    );
  }
}

async function attemptLogin() {
  const enteredPassword = dom.loginPassword.value.trim();
  if (!enteredPassword) {
    showLoginError("Enter your portal password to continue.");
    return;
  }

  const lockoutMessage = checkLockout();
  if (lockoutMessage) {
    applyLockoutState();
    return;
  }

  dom.loginBtn.disabled = true;
  dom.loginBtn.textContent = "Checking...";
  showLoginError("");

  try {
    await pingWorker(enteredPassword);

    localStorage.removeItem("failed_attempts");
    localStorage.removeItem("lockout_until");
    localStorage.setItem("portal_password", enteredPassword);

    dom.loginPassword.value = "";
    showApp();
    showToast("Signed in", "success");
  } catch (error) {
    if (error.message === "Incorrect portal password.") {
      const locked = recordFailedAttempt();
      const attempts = Number(localStorage.getItem("failed_attempts") || "0");
      const remaining = Math.max(MAX_ATTEMPTS - attempts, 0);
      const message = locked
        ? "Too many failed attempts. This device is locked out for 30 minutes."
        : `Incorrect password. ${remaining} attempt${remaining !== 1 ? "s" : ""} remaining.`;
      showLoginError(message);
      dom.loginPassword.value = "";
      dom.loginPassword.focus();
      if (locked) {
        applyLockoutState();
      }
    } else {
      showLoginError(error.message);
    }
  } finally {
    if (!checkLockout()) {
      dom.loginBtn.disabled = false;
      dom.loginPassword.disabled = false;
    }
    dom.loginBtn.textContent = "Enter";
  }
}

function logout() {
  localStorage.removeItem("portal_password");
  state.products.clear();
  state.lightspeedCache.clear();
  dom.productsContainer.innerHTML = "";
  dom.loginPassword.value = "";
  dom.settingsPanel.classList.add("hidden");
  setSearchStatus("No products loaded");
  showLoginError("");
  applyLockoutState();
  showLogin();
}

async function apiFetch(endpoint, options = {}) {
  const { workerUrl, portalPassword } = getConfig();
  if (!workerUrl) {
    throw new Error("Worker URL is missing.");
  }
  if (!portalPassword) {
    throw new Error("Please sign in first.");
  }

  const response = await fetch(`${workerUrl}${endpoint}`, {
    ...options,
    headers: buildAuthHeaders(portalPassword, {
      "Content-Type": "application/json",
      ...(options.headers || {}),
    }),
  });

  const data = await parseApiResponse(response);
  if (response.status === 401) {
    logout();
    throw new Error("Your session expired. Please sign in again.");
  }
  if (!response.ok) {
    throw new Error(data.error || `API error ${response.status}`);
  }
  return data;
}

async function testConnection() {
  const { portalPassword } = getConfig();
  if (!portalPassword) {
    showToast("Sign in first to test the protected connection", "error");
    return;
  }

  dom.testConnectionBtn.disabled = true;
  dom.testConnectionBtn.textContent = "Testing...";

  try {
    await pingWorker(portalPassword);
    showToast("Protected worker reachable", "success");
  } catch (error) {
    showToast(error.message, "error");
  } finally {
    dom.testConnectionBtn.disabled = false;
    dom.testConnectionBtn.textContent = "Test Connection";
  }
}

async function searchProducts() {
  const query = dom.searchInput.value.trim();
  dom.productsContainer.innerHTML =
    '<div class="loading-panel"><div class="loading">Searching products...</div></div>';
  setSearchStatus(query ? `Searching for "${query}"` : "Searching all products");

  try {
    const products = await apiFetch(
      `/api/products?search=${encodeURIComponent(query)}`
    );
    state.products.clear();
    state.lightspeedCache.clear();
    products.forEach((product) => state.products.set(String(product.id), product));
    renderProducts(products);

    setSearchStatus(
      products.length
        ? `${products.length} product${products.length !== 1 ? "s" : ""} loaded`
        : "No products matched your search"
    );
  } catch (error) {
    dom.productsContainer.innerHTML =
      `<div class="error-panel"><div class="error-state">${esc(error.message)}</div></div>`;
    setSearchStatus("Search failed");
  }
}

function renderProducts(products) {
  if (!products.length) {
    dom.productsContainer.innerHTML =
      '<div class="empty-panel"><div class="empty">No products found. Try a different search term.</div></div>';
    return;
  }

  dom.productsContainer.innerHTML = products
    .map((product) => {
      const imageUrl = product.images?.[0]?.src;
      const imageHtml = imageUrl
        ? `<img src="${esc(imageUrl)}" alt="" class="product-thumb">`
        : '<div class="product-thumb placeholder"></div>';

      return `
        <article class="product-card" data-product-id="${esc(String(product.id))}">
          <div class="product-header">
            <div class="product-info">
              ${imageHtml}
              <div class="product-text">
                <div class="product-title-row">
                  <h3>${esc(product.title)}</h3>
                  <span class="variant-count">${product.variants.length} variant${product.variants.length !== 1 ? "s" : ""}</span>
                </div>
                <div class="product-meta">
                  <span>Shopify</span>
                  <span>${esc(product.handle || "No handle")}</span>
                </div>
              </div>
            </div>
            <div class="product-header-right">
              <span class="expand-label">Review variants</span>
              <span class="expand-icon">&#9654;</span>
            </div>
          </div>
          <div class="product-variants hidden" id="variants-${product.id}"></div>
        </article>`;
    })
    .join("");
}

function onProductsClick(event) {
  const header = event.target.closest(".product-header");
  if (header) {
    const card = header.closest(".product-card");
    toggleProduct(card.dataset.productId);
    return;
  }

  const saveButton = event.target.closest(".btn-save");
  if (saveButton) {
    saveVariant(saveButton);
  }
}

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

  const product = state.products.get(String(productId));
  if (!product) return;

  if (variantsDiv.dataset.loaded === "true") return;

  variantsDiv.innerHTML =
    '<div class="variants-loading">Looking up linked Lightspeed variants...</div>';

  let lightspeedProducts = state.lightspeedCache.get(String(productId));

  if (!lightspeedProducts) {
    lightspeedProducts = [];
    try {
      const data = await apiFetch(
        `/api/lightspeed-product?shopifyProductId=${product.id}&title=${encodeURIComponent(product.title)}`
      );
      if (data.found) {
        lightspeedProducts = data.products || [];
      }
    } catch (error) {
      console.warn("Lightspeed lookup failed:", error.message);
    }

    state.lightspeedCache.set(String(productId), lightspeedProducts);
  }

  renderVariants(product, lightspeedProducts, variantsDiv);
  variantsDiv.dataset.loaded = "true";
}

function renderVariants(product, lightspeedProducts, container) {
  const matchCount = lightspeedProducts.length;
  const lightspeedBadge = matchCount
    ? `<span class="ls-badge found">${matchCount} Lightspeed match${matchCount !== 1 ? "es" : ""}</span>`
    : '<span class="ls-badge not-found">No Lightspeed match found</span>';

  const comparisonNote = matchCount
    ? "Saving a row updates Shopify first, then the matched Lightspeed variant for that same row."
    : "You can still update Shopify here. If Lightspeed is not linked, the row will report that instead of guessing.";

  const rows = product.variants
    .map((variant) => {
      const variantLabel = variant.title === "Default Title" ? "Base Variant" : variant.title;
      const lightspeedMatch = lightspeedProducts.find(
        (item) => String(item.source_variant_id) === String(variant.id)
      );
      const lightspeedPrice = lightspeedMatch
        ? lightspeedMatch.price_including_tax ?? lightspeedMatch.price ?? null
        : null;
      const lightspeedId = lightspeedMatch ? lightspeedMatch.id : "";
      const lightspeedName = lightspeedMatch
        ? lightspeedMatch.variant_name || lightspeedMatch.name || "Linked in Lightspeed"
        : "No linked Lightspeed variant";

      return `
        <tr data-variant-id="${esc(String(variant.id))}">
          <td class="variant-cell">
            <strong>${esc(variantLabel)}</strong>
            <span class="variant-secondary">${esc(lightspeedName)}</span>
          </td>
          <td>${esc(variant.sku || "—")}</td>
          <td class="current-price">$${esc(variant.price)}</td>
          <td class="current-price">${variant.compare_at_price ? "$" + esc(variant.compare_at_price) : "—"}</td>
          <td class="current-price">${lightspeedPrice !== null ? "$" + esc(String(lightspeedPrice)) : "—"}</td>
          <td><input type="number" step="0.01" min="0" class="input-price" value="${esc(variant.price)}"></td>
          <td><input type="number" step="0.01" min="0" class="input-compare" value="${esc(variant.compare_at_price || "")}" placeholder="Optional"></td>
          <td>
            <button
              class="btn-save"
              data-variant-id="${esc(String(variant.id))}"
              data-handle="${esc(product.title)}"
              data-ls-id="${esc(String(lightspeedId))}"
              type="button"
            >Save</button>
          </td>
          <td class="status-cell"></td>
        </tr>`;
    })
    .join("");

  container.innerHTML = `
    <div class="comparison-summary">
      <div class="comparison-copy">
        <h4>Live Price Comparison</h4>
        <p class="comparison-note">${esc(comparisonNote)}</p>
      </div>
      ${lightspeedBadge}
    </div>
    <div class="table-wrap">
      <table class="variants-table">
        <thead>
          <tr>
            <th>Variant</th>
            <th>SKU</th>
            <th>Shopify</th>
            <th>Compare At</th>
            <th>Lightspeed</th>
            <th>New Price</th>
            <th>New Compare</th>
            <th>Update</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
}

function renderStatusPill(label, type) {
  return `<span class="status-pill ${type}">${esc(label)}</span>`;
}

async function saveVariant(button) {
  const row = button.closest("tr");
  const variantId = button.dataset.variantId;
  const handle = button.dataset.handle;
  const lightspeedId = button.dataset.lsId || null;

  const priceInput = row.querySelector(".input-price");
  const compareInput = row.querySelector(".input-compare");
  const statusCell = row.querySelector(".status-cell");

  const price = priceInput.value.trim();
  const compareAtPrice = compareInput.value.trim() || null;

  if (!price || Number.isNaN(Number(price)) || Number(price) < 0) {
    showToast("Enter a valid price", "error");
    return;
  }

  button.disabled = true;
  button.textContent = "Saving...";
  statusCell.innerHTML = "";

  try {
    const result = await apiFetch("/api/update-price", {
      method: "POST",
      body: JSON.stringify({
        shopifyVariantId: variantId,
        handle,
        price,
        compareAtPrice,
        lightspeedProductId: lightspeedId,
      }),
    });

    const fragments = [];
    if (result.results.shopify?.success) {
      fragments.push(renderStatusPill("Shopify", "success"));
    }
    if (result.results.lightspeed?.success) {
      fragments.push(renderStatusPill("Lightspeed", "success"));
    }
    if (result.errors?.length) {
      result.errors.forEach((error) => {
        fragments.push(renderStatusPill(error.platform, "error"));
        showToast(`${error.platform}: ${error.error}`, "error");
      });
    }

    statusCell.innerHTML = fragments.join("");

    if (!result.errors?.length) {
      showToast("Prices updated", "success");
    }

    const currentCells = row.querySelectorAll(".current-price");
    currentCells[0].textContent = `$${price}`;
    currentCells[1].textContent = compareAtPrice ? `$${compareAtPrice}` : "—";
    if (result.results.lightspeed?.success) {
      currentCells[2].textContent = `$${price}`;
    }
  } catch (error) {
    statusCell.innerHTML = renderStatusPill("Failed", "error");
    showToast(error.message, "error");
  } finally {
    button.disabled = false;
    button.textContent = "Save";
  }
}

function showToast(message, type = "info") {
  const toast = document.createElement("div");
  toast.className = `toast ${type}`;
  toast.textContent = message;
  dom.toastContainer.appendChild(toast);
  setTimeout(() => toast.remove(), 4000);
}

function esc(value) {
  const div = document.createElement("div");
  div.textContent = value == null ? "" : String(value);
  return div.innerHTML;
}

document.addEventListener("DOMContentLoaded", init);
