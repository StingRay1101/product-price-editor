const MAX_ATTEMPTS = 5;
const LOCKOUT_MINUTES = 30;

const state = {
  products: new Map(),
  lightspeedCache: new Map(),
  authenticated: false,
  suggestedProducts: new Map(),
  suggestionTimer: null,
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
  searchSuggestions: $("#search-suggestions"),
  productsContainer: $("#products-container"),
  bulkSection: $("#bulk-section"),
  bulkFileInput: $("#bulk-file-input"),
  bulkProcessBtn: $("#bulk-process-btn"),
  bulkResultsContainer: $("#bulk-results-container"),
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
  dom.searchInput.addEventListener("input", onSearchInput);
  dom.searchInput.addEventListener("focus", () => {
    if (dom.searchInput.value.trim()) {
      queueSuggestionLookup(dom.searchInput.value.trim());
    }
  });
  dom.searchInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      hideSuggestions();
      searchProducts();
    }
  });

  dom.productsContainer.addEventListener("click", onProductsClick);
  dom.searchSuggestions.addEventListener("click", onSuggestionClick);
  dom.bulkProcessBtn.addEventListener("click", processBulkUploadFile);
  dom.bulkResultsContainer.addEventListener("click", onBulkResultsClick);

  document.addEventListener("click", (event) => {
    if (!event.target.closest(".search-shell")) {
      hideSuggestions();
    }
  });
}

function normalizeWorkerUrl(value) {
  let url = (value || "").trim().replace(/\/+$/, "");
  // Auto-add https:// if the user entered a bare domain
  if (url && !url.startsWith("http://") && !url.startsWith("https://")) {
    url = "https://" + url;
  }
  return url;
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
  dom.bulkSection.classList.toggle("hidden", !hasWorkerUrl || !state.authenticated);

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
    // If the response looks like HTML, the request probably went to the wrong server
    if (text.trim().startsWith("<!") || text.trim().startsWith("<html")) {
      return {
        error: `Got an HTML page instead of JSON - the Worker URL is probably wrong or the worker has not been deployed yet. Check Connection Settings.`,
      };
    }
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
  state.suggestedProducts.clear();
  dom.productsContainer.innerHTML = "";
  dom.bulkResultsContainer.innerHTML = "";
  dom.bulkFileInput.value = "";
  dom.loginPassword.value = "";
  dom.settingsPanel.classList.add("hidden");
  hideSuggestions();
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
  hideSuggestions();
  dom.productsContainer.innerHTML =
    '<div class="loading-panel"><div class="loading">Searching products...</div></div>';
  setSearchStatus(query ? `Searching for "${query}"` : "Searching all products");

  try {
    const products = await apiFetch(
      `/api/products?search=${encodeURIComponent(query)}`
    );
    loadProducts(products);
    setSearchStatus(products.length
      ? `${products.length} product${products.length !== 1 ? "s" : ""} loaded`
      : "No products matched your search");
  } catch (error) {
    dom.productsContainer.innerHTML =
      `<div class="error-panel"><div class="error-state">${esc(error.message)}</div></div>`;
    setSearchStatus("Search failed");
  }
}

function loadProducts(products) {
  state.products.clear();
  state.lightspeedCache.clear();
  products.forEach((product) => state.products.set(String(product.id), product));
  renderProducts(products);
}

function hideSuggestions() {
  dom.searchSuggestions.classList.add("hidden");
  dom.searchSuggestions.innerHTML = "";
  state.suggestedProducts.clear();
}

function queueSuggestionLookup(query) {
  clearTimeout(state.suggestionTimer);
  state.suggestionTimer = setTimeout(() => {
    loadSuggestions(query);
  }, 180);
}

function onSearchInput() {
  const query = dom.searchInput.value.trim();
  if (!query) {
    clearTimeout(state.suggestionTimer);
    hideSuggestions();
    return;
  }

  queueSuggestionLookup(query);
}

async function loadSuggestions(query) {
  if (!state.authenticated || !query) {
    hideSuggestions();
    return;
  }

  try {
    const products = await apiFetch(
      `/api/products?search=${encodeURIComponent(query)}&limit=8&suggest=1`
    );

    if (dom.searchInput.value.trim() !== query) {
      return;
    }

    renderSuggestions(products, query);
  } catch (error) {
    console.warn("Suggestion lookup failed:", error.message);
    hideSuggestions();
  }
}

function renderSuggestions(products, query) {
  if (!query || !products.length) {
    hideSuggestions();
    return;
  }

  state.suggestedProducts.clear();
  products.forEach((product) => {
    state.suggestedProducts.set(String(product.id), product);
  });

  const items = products
    .map((product) => {
      const skus = Array.from(
        new Set(
          (product.variants || [])
            .map((variant) => (variant.sku || "").trim())
            .filter(Boolean)
        )
      ).slice(0, 3);

      const skuLabel = skus.length ? skus.join(" • ") : "No SKU";

      return `
        <button
          class="suggestion-item"
          type="button"
          data-product-id="${esc(String(product.id))}"
        >
          <span class="suggestion-main">
            <span class="suggestion-title">${esc(product.title)}</span>
            <span class="suggestion-meta">${product.variants.length} variant${product.variants.length !== 1 ? "s" : ""} • ${esc(product.handle || "No handle")}</span>
          </span>
          <span class="suggestion-skus">${esc(skuLabel)}</span>
        </button>`;
    })
    .join("");

  dom.searchSuggestions.innerHTML = `
    <div class="suggestions-label">Suggested Matches</div>
    ${items}`;
  dom.searchSuggestions.classList.remove("hidden");
}

function onSuggestionClick(event) {
  const button = event.target.closest(".suggestion-item");
  if (!button) return;

  const product = state.suggestedProducts.get(button.dataset.productId);
  if (!product) return;

  dom.searchInput.value = product.title;
  hideSuggestions();
  loadProducts([product]);
  setSearchStatus("1 suggested product loaded");
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

  const copyAllBtn = event.target.closest(".btn-copy-all");
  if (copyAllBtn) {
    copyFirstToAll(copyAllBtn);
    return;
  }

  const saveAllBtn = event.target.closest(".btn-save-all");
  if (saveAllBtn) {
    saveAllVariants(saveAllBtn);
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
      const lightspeedCost = lightspeedMatch
        ? lightspeedMatch.supply_price ?? null
        : null;
      const lightspeedId = lightspeedMatch ? lightspeedMatch.id : "";
      const lightspeedName = lightspeedMatch
        ? lightspeedMatch.variant_name || lightspeedMatch.name || "Linked in Lightspeed"
        : "No linked Lightspeed variant";

      const hasCompare = Boolean(variant.compare_at_price) && parseFloat(variant.compare_at_price) > 0;

      return `
        <tr data-variant-id="${esc(String(variant.id))}">
          <td class="variant-cell">
            <strong>${esc(variantLabel)}</strong>
            <span class="variant-secondary">${esc(lightspeedName)}</span>
          </td>
          <td>${esc(variant.sku || "-")}</td>
          <td class="current-price">$${esc(variant.price)}</td>
          <td class="current-price">${variant.compare_at_price ? "$" + esc(variant.compare_at_price) : "-"}</td>
          <td class="current-price">${lightspeedPrice !== null ? "$" + esc(String(lightspeedPrice)) : "-"}</td>
          <td class="current-price cost-price">${lightspeedCost !== null ? "$" + esc(String(lightspeedCost)) : "-"}</td>
          <td><input type="number" step="0.01" min="0" class="input-price" value="${esc(variant.price)}"></td>
          <td><input type="number" step="0.01" min="0" class="input-compare${hasCompare ? " compare-locked" : ""}" value="${esc(variant.compare_at_price || "")}" placeholder="${hasCompare ? "" : "Optional"}"${hasCompare ? ` readonly title="Compare price is locked — already set in Shopify"` : ""}></td>
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

  const showBulk = product.variants.length > 1;

  container.innerHTML = `
    <div class="comparison-summary">
      <div class="comparison-copy">
        <h4>Live Price Comparison</h4>
        <p class="comparison-note">${esc(comparisonNote)}</p>
      </div>
      ${lightspeedBadge}
    </div>
    ${showBulk ? `<div class="bulk-actions">
      <button class="btn-copy-all btn-secondary" type="button" data-product-id="${esc(String(product.id))}">Copy First to All</button>
      <button class="btn-save-all" type="button" data-product-id="${esc(String(product.id))}">Save All Variants</button>
    </div>` : ""}
    <div class="table-wrap">
      <table class="variants-table">
        <thead>
          <tr>
            <th>Variant</th>
            <th>SKU</th>
            <th>Shopify</th>
            <th>Compare At</th>
            <th>Lightspeed</th>
            <th>Supplier Cost</th>
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

function copyFirstToAll(button) {
  const card = button.closest(".product-card");
  const rows = card.querySelectorAll(".variants-table tbody tr");
  if (rows.length < 2) return;

  const firstRow = rows[0];
  const sourcePrice = firstRow.querySelector(".input-price").value;
  const sourceCompare = firstRow.querySelector(".input-compare").value;

  for (let i = 1; i < rows.length; i++) {
    rows[i].querySelector(".input-price").value = sourcePrice;
    const compareInput = rows[i].querySelector(".input-compare");
    if (compareInput && !compareInput.readOnly) {
      compareInput.value = sourceCompare;
    }
  }

  showToast(`Copied price to ${rows.length - 1} variant${rows.length - 1 !== 1 ? "s" : ""}`, "success");
}

async function saveAllVariants(button) {
  const card = button.closest(".product-card");
  const saveButtons = card.querySelectorAll(".btn-save");
  if (!saveButtons.length) return;

  button.disabled = true;
  button.textContent = "Saving...";

  let saved = 0;
  let failed = 0;

  for (const btn of saveButtons) {
    if (btn.disabled) continue;
    try {
      await saveVariant(btn);
      saved++;
    } catch {
      failed++;
    }
  }

  button.disabled = false;
  button.textContent = "Save All Variants";

  if (failed) {
    showToast(`${saved} saved, ${failed} failed`, "error");
  } else {
    showToast(`All ${saved} variant${saved !== 1 ? "s" : ""} saved`, "success");
  }
}

async function processBulkUploadFile() {
  const file = dom.bulkFileInput.files[0];
  if (!file) {
    showToast("Choose a file first", "error");
    return;
  }

  if (typeof XLSX === "undefined") {
    showToast("Spreadsheet library did not load. Refresh and try again.", "error");
    return;
  }

  dom.bulkProcessBtn.disabled = true;
  dom.bulkProcessBtn.textContent = "Reading...";
  dom.bulkResultsContainer.innerHTML =
    '<div class="loading-panel"><div class="loading">Reading spreadsheet...</div></div>';

  try {
    const items = await readBulkFile(file);

    if (!items.length) {
      dom.bulkResultsContainer.innerHTML =
        '<div class="empty-panel"><div class="empty">No SKU/Price rows found in that file.</div></div>';
      return;
    }

    dom.bulkResultsContainer.innerHTML =
      '<div class="loading-panel"><div class="loading">Matching against Shopify...</div></div>';

    const data = await apiFetch("/api/bulk-price-lookup", {
      method: "POST",
      body: JSON.stringify({ items }),
    });

    renderBulkResults(data.results || [], data.summary || null);
  } catch (error) {
    dom.bulkResultsContainer.innerHTML =
      `<div class="error-panel"><div class="error-state">${esc(error.message)}</div></div>`;
  } finally {
    dom.bulkProcessBtn.disabled = false;
    dom.bulkProcessBtn.textContent = "Process File";
  }
}

function readBulkFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Could not read that file."));
    reader.onload = () => {
      try {
        const workbook = XLSX.read(reader.result, { type: "array" });
        const sheet = workbook.Sheets[workbook.SheetNames[0]];
        const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "" });
        resolve(parseBulkRows(rows));
      } catch (error) {
        reject(new Error("Could not read that spreadsheet. Check it is a valid .xlsx file."));
      }
    };
    reader.readAsArrayBuffer(file);
  });
}

function parsePriceCell(value) {
  if (typeof value === "number") return value;
  const cleaned = String(value || "").replace(/[^0-9.\-]/g, "");
  return cleaned === "" ? NaN : Number(cleaned);
}

function parseBulkRows(rows) {
  if (!rows.length) return [];

  const maxHeaderScan = Math.min(rows.length, 5);
  let headerRowIndex = -1;
  let skuCol = -1;
  let priceCol = -1;

  for (let i = 0; i < maxHeaderScan; i++) {
    const candidate = (rows[i] || []).map((cell) => String(cell || "").trim().toLowerCase());
    const skuIdx = candidate.findIndex((cell) => cell.includes("sku"));
    if (skuIdx === -1) continue;
    headerRowIndex = i;
    skuCol = skuIdx;
    const priceIdx = candidate.findIndex((cell) => cell.includes("price"));
    priceCol = priceIdx !== -1 ? priceIdx : candidate.findIndex((_, index) => index !== skuIdx);
    if (priceCol === -1) priceCol = skuCol === 0 ? 1 : 0;
    break;
  }

  const startIndex = headerRowIndex !== -1 ? headerRowIndex + 1 : 0;
  if (skuCol === -1) skuCol = 0;
  if (priceCol === -1) priceCol = 1;

  const items = [];
  for (let i = startIndex; i < rows.length; i++) {
    const row = rows[i] || [];
    const sku = String(row[skuCol] || "").trim();
    if (!sku) continue;
    // Defensive skip, in case a stray header row still slips through
    if (sku.toLowerCase() === "sku" || sku.toLowerCase() === "price") continue;
    const price = parsePriceCell(row[priceCol]);
    items.push({ sku, price: Number.isFinite(price) ? price : null });
  }

  return items;
}

function renderBulkResults(results, summary) {
  if (!results.length) {
    dom.bulkResultsContainer.innerHTML =
      '<div class="empty-panel"><div class="empty">No rows to show.</div></div>';
    return;
  }

  const totalUploaded = summary ? summary.totalUploaded : results.length;
  const matchedUploaded = summary
    ? summary.matchedUploaded
    : results.filter((result) => result.found).length;
  const fanOutNote = results.length > totalUploaded
    ? " Some SKUs matched more than one size variant, so they appear as separate rows below."
    : "";

  const rows = results
    .map((result) => {
      const hasValidUpload = result.uploadedPrice !== null && Number.isFinite(Number(result.uploadedPrice));
      const uploadedPrice = hasValidUpload ? Number(result.uploadedPrice) : null;
      const currentPrice = result.found ? Number(result.currentPrice) : null;
      const isMarkdown = result.found && hasValidUpload && currentPrice !== null && uploadedPrice < currentPrice;
      const needsReview = !result.found || !hasValidUpload || !isMarkdown;

      const newPriceValue = isMarkdown ? uploadedPrice : "";
      const newCompareValue = isMarkdown ? result.currentPrice : "";
      const bulkHasCompare = result.found && result.currentCompareAt && parseFloat(result.currentCompareAt) > 0;
      const bulkCompareValue = bulkHasCompare ? result.currentCompareAt : newCompareValue;

      return `
        <tr class="${needsReview ? "bulk-row-flagged" : ""}">
          <td><strong>${esc(result.sku)}</strong></td>
          <td>${esc(result.productTitle || "No matching product found")}</td>
          <td class="current-price">${result.found ? "$" + esc(String(result.currentPrice)) : "-"}</td>
          <td class="current-price">${result.found && result.currentCompareAt ? "$" + esc(String(result.currentCompareAt)) : "-"}</td>
          <td>${hasValidUpload ? "$" + esc(String(uploadedPrice)) : '<span class="bulk-flag-text">Invalid price</span>'}</td>
          <td><input type="number" step="0.01" min="0" class="input-price" value="${esc(String(newPriceValue))}" ${result.found ? "" : "disabled"}></td>
          <td><input type="number" step="0.01" min="0" class="input-compare${bulkHasCompare ? " compare-locked" : ""}" value="${esc(String(bulkCompareValue))}" placeholder="${bulkHasCompare ? "" : "Optional"}" ${result.found ? "" : "disabled"}${bulkHasCompare ? ` readonly title="Compare price is locked — already set in Shopify"` : ""}></td>
          <td>
            ${result.found
              ? `<button class="btn-save" data-variant-id="${esc(String(result.variantId))}" data-handle="${esc(result.productTitle || result.sku)}" data-ls-id="" type="button">Save</button>`
              : '<span class="bulk-flag-text">No match</span>'}
          </td>
          <td class="status-cell"></td>
        </tr>`;
    })
    .join("");

  dom.bulkResultsContainer.innerHTML = `
    <div class="product-card">
      <div class="product-variants">
        <div class="comparison-summary">
          <div class="comparison-copy">
            <h4>Bulk Price Review</h4>
            <p class="comparison-note">
              ${matchedUploaded} of ${totalUploaded} SKU${totalUploaded !== 1 ? "s" : ""} matched. Rows in red need the new price
              (and compare-at, if you want one) entered manually before they can be saved.${fanOutNote}
            </p>
          </div>
        </div>
        <div class="bulk-actions">
          <button class="btn-save-all" type="button" id="bulk-save-all-btn">Save All Ready Rows</button>
        </div>
        <div class="table-wrap">
          <table class="variants-table">
            <thead>
              <tr>
                <th>SKU</th>
                <th>Product</th>
                <th>Current Price</th>
                <th>Current Compare</th>
                <th>Uploaded Price</th>
                <th>New Price</th>
                <th>New Compare</th>
                <th>Update</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
      </div>
    </div>`;
}

function onBulkResultsClick(event) {
  const saveAllBtn = event.target.closest("#bulk-save-all-btn");
  if (saveAllBtn) {
    saveAllBulkRows(saveAllBtn);
    return;
  }

  const saveButton = event.target.closest(".btn-save");
  if (saveButton) {
    saveVariant(saveButton);
  }
}

async function saveAllBulkRows(button) {
  const saveButtons = dom.bulkResultsContainer.querySelectorAll(".btn-save");
  if (!saveButtons.length) return;

  button.disabled = true;
  button.textContent = "Saving...";

  let saved = 0;
  let skipped = 0;

  for (const btn of saveButtons) {
    if (btn.disabled) continue;
    const row = btn.closest("tr");
    const priceValue = row.querySelector(".input-price").value.trim();
    if (!priceValue) {
      skipped++;
      continue;
    }
    await saveVariant(btn);
    saved++;
  }

  button.disabled = false;
  button.textContent = "Save All Ready Rows";

  const parts = [`${saved} saved`];
  if (skipped) parts.push(`${skipped} skipped, no price entered`);
  showToast(parts.join(", "), "success");
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
    currentCells[1].textContent = compareAtPrice ? `$${compareAtPrice}` : "-";
    if (result.results.lightspeed?.success && currentCells[2]) {
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
