import {
  OrderDiscountSelectionStrategy,
  ProductDiscountSelectionStrategy,
  DiscountClass,
} from "../generated/api";

export function cartLinesDiscountsGenerateRun(input) {
  if (!input.cart.lines.length) {
    return { operations: [] };
  }

  const config = parseMetafield(input.discount.metafield);

  const hasOrderDiscountClass = input.discount.discountClasses.includes(DiscountClass.Order);
  const hasProductDiscountClass = input.discount.discountClasses.includes(DiscountClass.Product);

  if (!hasOrderDiscountClass && !hasProductDiscountClass) {
    return { operations: [] };
  }

  // Resolve GWP lines first so they are excluded from all tier calculations.
  // The spend threshold is checked against NON-gift items only (see function below).
  const gwpLineIds = resolveGwpLineIds(input.cart.lines, config);

  // Non-GWP subtotal and quantity — used for order-value and quantity tier evaluation
  const cartSubtotal = input.cart.lines.reduce(
    (sum, line) => gwpLineIds.has(line.id) ? sum : sum + parseFloat(line.cost.subtotalAmount.amount),
    0,
  );
  const totalQuantity = input.cart.lines.reduce(
    (sum, line) => gwpLineIds.has(line.id) ? sum : sum + line.quantity,
    0,
  );

  const operations = [];

  // ─────────────────────────────────────────────────────────────
  // PRODUCT DISCOUNT BLOCK
  //
  // Each non-GWP line is discounted ONLY if the product has bulk_discount
  // metafields configured AND the cart quantity reaches a tier threshold.
  // No default flat discount is applied — if no tier matches, no discount.
  // Quantity-tier discount lives at ORDER level (see below) so it never
  // competes with per-product bulk tiers.
  // ─────────────────────────────────────────────────────────────
  if (hasProductDiscountClass) {
    const bulkDiscountByLine = computeBulkDiscounts(input.cart.lines, gwpLineIds);

    const productCandidates = [];

    for (const line of input.cart.lines) {
      const product = line.merchandise?.product;
      if (!product) continue;

      // GWP lines: only the first unit is free. quantity: 1 ensures that even
      // if the customer adds 2+ of the gift product, only 1 gets 100% off.
      if (gwpLineIds.has(line.id)) {
        productCandidates.push({
          targets: [{ cartLine: { id: line.id, quantity: 1 } }],
          message: "Free Gift",
          value: { percentage: { value: 100 } },
        });
        continue;
      }

      // Check whether this product has bulk discount metafields configured.
      // If yes, bulk discount is the ONLY product-level discount source for
      // this line — cartLinePercentage is intentionally skipped so that the
      // merchant-configured per-product tiers are never suppressed by the
      // global flat rate.
      const hasBulkMetafields =
        parseMetafieldArray(product.minQuantity?.value) !== null &&
        parseMetafieldArray(product.discountPercent?.value) !== null;

      const bulkDiscount = bulkDiscountByLine.get(line.id);

      const candidates = [];

      // Only apply bulk discount when the product has metafields configured
      // AND the cart quantity meets a tier threshold.
      // No fallback flat discount — if neither condition is met, skip this line.
      if (hasBulkMetafields && bulkDiscount != null && bulkDiscount > 0) {
        candidates.push({ value: bulkDiscount, message: `${bulkDiscount}% Bulk Discount` });
      }

      if (candidates.length === 0) continue;

      const best = candidates.reduce((a, b) => (b.value > a.value ? b : a));
      productCandidates.push({
        targets: [{ cartLine: { id: line.id } }],
        message: best.message,
        value: { percentage: { value: best.value } },
      });
    }

    if (productCandidates.length > 0) {
      operations.push({
        productDiscountsAdd: {
          candidates: productCandidates,
          selectionStrategy: ProductDiscountSelectionStrategy.All,
        },
      });
    }
  }

  // ─────────────────────────────────────────────────────────────
  // ORDER DISCOUNT BLOCK
  //
  // Order-value tier and quantity tier compete; the highest wins.
  // Nothing is applied unless a configured tier threshold is actually met.
  // GWP lines are excluded from the order subtotal target.
  // ─────────────────────────────────────────────────────────────
  if (hasOrderDiscountClass) {
    const orderTierDiscount = resolveOrderTierDiscount(cartSubtotal, config.orderDiscount.tiers);
    const qtyTierDiscount   = resolveQuantityDiscount(totalQuantity, config.quantityDiscount.tiers);

    // Only apply order-level discounts when a configured tier is actually met.
    // No fallback flat order percentage — nothing applies unless a tier matches.
    const orderCandidates = [];

    if (orderTierDiscount > 0) {
      orderCandidates.push({
        value: orderTierDiscount,
        message: `${orderTierDiscount}% OFF ORDER`,
      });
    }
    if (qtyTierDiscount > 0) {
      orderCandidates.push({
        value: qtyTierDiscount,
        message: `${qtyTierDiscount}% Qty Discount`,
      });
    }

    if (orderCandidates.length > 0) {
      const best = orderCandidates.reduce((a, b) => (b.value > a.value ? b : a));
      operations.push({
        orderDiscountsAdd: {
          candidates: [
            {
              message: best.message,
              targets: [{ orderSubtotal: { excludedCartLineIds: [...gwpLineIds] } }],
              value: { percentage: { value: best.value } },
            },
          ],
          selectionStrategy: OrderDiscountSelectionStrategy.First,
        },
      });
    }
  }

  return { operations };
}

// ─────────────────────────────────────────────────────────────
// Pre-compute bulk discount per cart line from product metafields.
// Groups lines by product, totals quantity, applies highest qualifying tier.
// Returns Map<lineId, discountPercent>
// ─────────────────────────────────────────────────────────────
function computeBulkDiscounts(lines, gwpLineIds) {
  const productGroups = new Map();

  for (const line of lines) {
    if (gwpLineIds.has(line.id)) continue;

    const product = line.merchandise?.product;
    if (!product) continue;

    const minQuantities   = parseMetafieldArray(product.minQuantity?.value);
    const discountPercents = parseMetafieldArray(product.discountPercent?.value);

    if (
      !minQuantities ||
      !discountPercents ||
      minQuantities.length !== discountPercents.length
    ) {
      continue;
    }

    if (!productGroups.has(product.id)) {
      productGroups.set(product.id, {
        lines: [],
        totalQuantity: 0,
        minQuantities,
        discountPercents,
      });
    }

    const group = productGroups.get(product.id);
    group.lines.push(line);
    group.totalQuantity += line.quantity;
  }

  const result = new Map();

  for (const [, group] of productGroups) {
    const discount = getApplicableDiscount(
      group.totalQuantity,
      group.minQuantities,
      group.discountPercents,
    );
    if (discount === null) continue;
    for (const line of group.lines) {
      result.set(line.id, discount);
    }
  }

  return result;
}

// ─────────────────────────────────────────────────────────────
// Free Gift: identify cart lines that qualify for 100% off.
//
// Spend threshold is checked against NON-gift items only so that:
//   • Adding a gift product to the cart does not inflate the
//     qualifying subtotal and trigger its own free status.
//   • Removing / adding more gift items doesn't change whether
//     the threshold is met.
//
// Only 1 unit per matching line is discounted (quantity: 1 on
// the candidate target). Extra units remain at full price.
// ─────────────────────────────────────────────────────────────
function resolveGwpLineIds(lines, config) {
  const result = new Set();
  const { freeGift } = config;

  if (!freeGift.enabled) return result;

  const giftProductIds = new Set(freeGift.productIds);
  const hasCollections = freeGift.collectionIds.length > 0;

  // Pass 1 — identify which lines are potential gift lines
  const potentialGiftIds = new Set();
  for (const line of lines) {
    const product = line.merchandise?.product;
    if (!product) continue;
    const isGiftProduct    = giftProductIds.has(product.id);
    const isGiftCollection = hasCollections && product.inAnyGiftCollection === true;
    if (isGiftProduct || isGiftCollection) {
      potentialGiftIds.add(line.id);
    }
  }

  // Pass 2 — compute spend from NON-gift lines only
  const nonGiftSubtotal = lines.reduce(
    (sum, line) =>
      potentialGiftIds.has(line.id)
        ? sum
        : sum + parseFloat(line.cost.subtotalAmount.amount),
    0,
  );

  // Only activate GWP if real (non-gift) spend meets the threshold
  if (nonGiftSubtotal < freeGift.minSpend) return result;

  for (const id of potentialGiftIds) {
    result.add(id);
  }

  return result;
}

// ─────────────────────────────────────────────────────────────
// Order-value tier: highest qualifying discount for the cart subtotal
// ─────────────────────────────────────────────────────────────
function resolveOrderTierDiscount(cartSubtotal, tiers) {
  let best = 0;
  for (const tier of tiers) {
    const amount   = Number(tier.amount);
    const discount = Number(tier.discount);
    if (amount <= 0 || discount <= 0) continue;
    if (cartSubtotal >= amount && discount > best) {
      best = discount;
    }
  }
  return best;
}

// ─────────────────────────────────────────────────────────────
// Quantity tier: highest qualifying discount for total item count
// ─────────────────────────────────────────────────────────────
function resolveQuantityDiscount(totalQuantity, tiers) {
  let best = 0;
  for (const tier of tiers) {
    const qty      = Number(tier.qty);
    const discount = Number(tier.discount);
    if (qty <= 0 || discount <= 0) continue;
    if (totalQuantity >= qty && discount > best) {
      best = discount;
    }
  }
  return best;
}

// ─────────────────────────────────────────────────────────────
// Bulk: highest tier for a product's accumulated quantity
// ─────────────────────────────────────────────────────────────
function getApplicableDiscount(totalQuantity, minQuantities, discountPercents) {
  let best = null;
  for (let i = 0; i < minQuantities.length; i++) {
    if (totalQuantity >= minQuantities[i]) {
      best = discountPercents[i];
    }
  }
  return best;
}

// ─────────────────────────────────────────────────────────────
// Parse $app:function-configuration metafield
// ─────────────────────────────────────────────────────────────
function parseMetafield(metafield) {
  try {
    const v = JSON.parse(metafield?.value || "{}");
    return {
      collectionIds: Array.isArray(v.collectionIds) ? v.collectionIds : [],
      freeGift: {
        enabled:       Boolean(v.freeGift?.enabled),
        productIds:    Array.isArray(v.freeGift?.productIds) ? v.freeGift.productIds : [],
        collectionIds: Array.isArray(v.freeGift?.collectionIds) ? v.freeGift.collectionIds : [],
        minSpend:      Number(v.freeGift?.minSpend) || 0,
      },
      orderDiscount: {
        tiers: Array.isArray(v.orderDiscount?.tiers) ? v.orderDiscount.tiers : [],
      },
      quantityDiscount: {
        tiers: Array.isArray(v.quantityDiscount?.tiers) ? v.quantityDiscount.tiers : [],
      },
    };
  } catch (err) {
    console.error("parseMetafield error", err);
    return {
      collectionIds: [],
      freeGift: { enabled: false, productIds: [], collectionIds: [], minSpend: 0 },
      orderDiscount:    { tiers: [] },
      quantityDiscount: { tiers: [] },
    };
  }
}

function parseMetafieldArray(value) {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed) && parsed.length > 0) {
      return parsed.map(Number);
    }
    return null;
  } catch {
    return null;
  }
}
