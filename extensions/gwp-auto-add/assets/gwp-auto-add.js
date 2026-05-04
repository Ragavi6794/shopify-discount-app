/**
 * GWP Auto-Add
 *
 * Reads the gift product automatically from the Storefront API.
 * No theme block settings required.
 *
 * Setup (once, on the gift product):
 *   1. Add tag  gwp-gift  to the product
 *   2. Set metafield  gwp.min_spend  to the minimum spend amount (e.g. 499)
 *   3. Deploy the app so the metafield definition is registered
 *
 * The script then:
 *   - Finds the first product tagged  gwp-gift  via Storefront API
 *   - Reads its gwp.min_spend metafield as the threshold
 *   - Auto-adds / auto-removes that product based on the cart subtotal
 */

(function () {
  "use strict";

  if (window.__GWP_INIT__) return;
  window.__GWP_INIT__ = true;

  const GWP_PROP       = "_gwp_auto";
  const GWP_TAG        = "gwp-gift";
  const GWP_NS         = "gwp";
  const GWP_KEY        = "min_spend";
  const STOREFRONT_VER = "2026-01";

  // Storefront API public token — Shopify injects this into most themes.
  // We check several common theme globals before falling back to unauthenticated.
  function getStorefrontToken() {
    return (
      window.Shopify?.storefrontToken ||
      window.Shopify?.theme?.storefrontToken ||
      window.__STOREFRONT_ACCESS_TOKEN__ ||
      ""
    );
  }

  const shopDomain =
    window.__SHOP_DOMAIN__ ||
    window.Shopify?.shop ||
    window.location.hostname;

  let _syncing      = false;
  let _pendingSync  = false;
  let _debounceTimer = null;

  // Resolved once on boot
  let _variantId = null;
  let _minSpend  = null;

  // ─────────────────────────────────────────────────────────────────
  // 1. Discover the gift product via Storefront API
  // ─────────────────────────────────────────────────────────────────
  async function loadGiftConfig() {
    const token = getStorefrontToken();
    const headers = { "Content-Type": "application/json" };
    if (token) headers["X-Shopify-Storefront-Access-Token"] = token;

    const query = `{
      products(first: 5, query: "tag:${GWP_TAG}") {
        nodes {
          id
          title
          minSpendMeta: metafield(namespace: "${GWP_NS}", key: "${GWP_KEY}") {
            value
          }
          variants(first: 1) {
            nodes {
              id
              availableForSale
            }
          }
        }
      }
    }`;

    const res = await fetch(
      `/api/${STOREFRONT_VER}/graphql.json`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({ query }),
      },
    );

    if (!res.ok) {
      console.warn(`[GWP] Storefront API returned ${res.status}. Make sure the storefront token is available.`);
      return false;
    }

    const json = await res.json();
    const products = json?.data?.products?.nodes || [];

    // Find first gift product with min_spend metafield + an available variant
    for (const product of products) {
      const minSpendValue = product.minSpendMeta?.value;
      if (!minSpendValue) continue;

      const variant = product.variants?.nodes?.find((v) => v.availableForSale);
      if (!variant) continue;

      // Storefront API returns GIDs like gid://shopify/ProductVariant/12345
      // Cart API needs the numeric ID
      const numericId = Number(variant.id.split("/").pop());
      if (!numericId) continue;

      _variantId = numericId;
      _minSpend  = Number(minSpendValue);
      console.log(`[GWP] Gift product: "${product.title}" | Variant: ${_variantId} | Min spend: ${_minSpend}`);
      return true;
    }

    console.warn(
      `[GWP] No gift product found. Make sure a product has tag "${GWP_TAG}" and metafield "${GWP_NS}.${GWP_KEY}" set.`,
    );
    return false;
  }

  // ─────────────────────────────────────────────────────────────────
  // 2. Cart AJAX helpers
  // ─────────────────────────────────────────────────────────────────
  async function fetchCart() {
    const res = await fetch("/cart.js", { cache: "no-store" });
    return res.json();
  }

  async function addGift() {
    const res = await fetch("/cart/add.js", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        items: [{
          id:         _variantId,
          quantity:   1,
          properties: { [GWP_PROP]: "true" },
        }],
      }),
    });
    const data = await res.json();
    if (data.status) {
      console.error("[GWP] Add gift failed:", data.description || data.message);
    } else {
      console.log("[GWP] ✅ Gift added to cart.");
    }
  }

  async function removeItem(key) {
    await fetch("/cart/change.js", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: key, quantity: 0 }),
    });
    console.log("[GWP] ❌ Gift removed from cart.");
  }

  async function setQuantity(key, qty) {
    await fetch("/cart/change.js", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: key, quantity: qty }),
    });
  }

  // ─────────────────────────────────────────────────────────────────
  // 3. Core sync — runs after every cart mutation
  // ─────────────────────────────────────────────────────────────────
  async function syncGift() {
    if (!_variantId || !_minSpend) return; // config not loaded yet

    if (_syncing) { _pendingSync = true; return; }
    _syncing     = true;
    _pendingSync = false;

    try {
      const cart = await fetchCart();

      const isGiftLine = (item) =>
        item.variant_id === _variantId && item.properties?.[GWP_PROP] === "true";

      const giftLine = cart.items.find(isGiftLine);

      // Non-gift subtotal (cents → store currency)
      const nonGiftSubtotal =
        cart.items
          .filter((item) => !isGiftLine(item))
          .reduce((sum, item) => sum + item.line_price, 0) / 100;

      const thresholdMet = nonGiftSubtotal >= _minSpend;

      console.log(
        `[GWP] Subtotal: ${nonGiftSubtotal} | Threshold: ${_minSpend} | Met: ${thresholdMet} | Gift in cart: ${!!giftLine}`,
      );

      if (thresholdMet && !giftLine) {
        await addGift();
        refreshCart();
      } else if (!thresholdMet && giftLine) {
        await removeItem(giftLine.key);
        refreshCart();
      } else if (thresholdMet && giftLine && giftLine.quantity !== 1) {
        await setQuantity(giftLine.key, 1);
        refreshCart();
      }
    } catch (err) {
      console.error("[GWP] sync error:", err);
    } finally {
      _syncing = false;
      if (_pendingSync) setTimeout(syncGift, 200);
    }
  }

  // ─────────────────────────────────────────────────────────────────
  // 4. Cart UI refresh
  // ─────────────────────────────────────────────────────────────────
  function refreshCart() {
    document.dispatchEvent(new CustomEvent("cart:refresh",  { bubbles: true }));
    document.dispatchEvent(new CustomEvent("cart:updated",  { bubbles: true }));

    // Section rendering — auto-discover cart/header sections
    const sectionIds = [];
    document.querySelectorAll("[id^='shopify-section-']").forEach((el) => {
      const id = el.id.replace("shopify-section-", "");
      if (id.includes("cart") || id.includes("header")) sectionIds.push(id);
    });

    if (sectionIds.length > 0) {
      fetch(`/?sections=${sectionIds.join(",")}`, { cache: "no-store" })
        .then((r) => r.json())
        .then((sections) => {
          Object.entries(sections).forEach(([id, html]) => {
            const el = document.getElementById(`shopify-section-${id}`);
            if (el) el.innerHTML = html;
          });
        })
        .catch(() => {});
    }

    if (window.location.pathname === "/cart") window.location.reload();
  }

  function debouncedSync(delay) {
    clearTimeout(_debounceTimer);
    _debounceTimer = setTimeout(syncGift, delay || 400);
  }

  // ─────────────────────────────────────────────────────────────────
  // 5. Intercept all cart AJAX mutations
  // ─────────────────────────────────────────────────────────────────
  const _origFetch = window.fetch;
  window.fetch = async function (...args) {
    const result = await _origFetch.apply(this, args);
    const url = typeof args[0] === "string" ? args[0] : (args[0]?.url ?? "");

    const isCartMutation =
      url.includes("/cart/add") ||
      url.includes("/cart/change") ||
      url.includes("/cart/update") ||
      url.includes("/cart/clear");

    if (isCartMutation && !_syncing) {
      result.clone().json()
        .then(() => debouncedSync(450))
        .catch(() => debouncedSync(450));
    }

    return result;
  };

  // ─────────────────────────────────────────────────────────────────
  // 6. Boot — load config then start watching
  // ─────────────────────────────────────────────────────────────────
  async function boot() {
    const ok = await loadGiftConfig();
    if (!ok) return;

    syncGift(); // run once on page load

    document.addEventListener("cart:updated", () => debouncedSync(300));
    document.addEventListener("cart:change",  () => debouncedSync(300));
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
