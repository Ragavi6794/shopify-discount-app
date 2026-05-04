import "@shopify/ui-extensions/preact";
import { render } from "preact";
import { useState, useMemo, useRef, useCallback, useEffect } from "preact/hooks";

export default async () => {
  render(<App />, document.body);
};

function App() {
  const { applyMetafieldChange, data, resourcePicker } = shopify;

  const initial = useMemo(
    () =>
      parseConfig(
        data?.metafields?.find((m) => m.key === "function-configuration")?.value,
      ),
    [],
  );

  const stateRef    = useRef(null);
  const formRef     = useRef(null);
  const debounceRef = useRef(null);

  // ── Free Gift ─────────────────────────────────────────────
  const [giftEnabled, setGiftEnabled]   = useState(initial.freeGift.enabled);
  const [giftType, setGiftType]         = useState(initial.freeGift.type);
  const [giftItems, setGiftItems]       = useState(initial.freeGift.items);
  const [giftMinSpend, setGiftMinSpend] = useState(
    initial.freeGift.minSpend > 0 ? String(initial.freeGift.minSpend) : "",
  );

  // ── Order Value tiers ─────────────────────────────────────
  const [orderTiers, setOrderTiers]             = useState(initial.orderDiscount.tiers);
  const [editingOrderTier, setEditingOrderTier] = useState(null);

  // ── Quantity tiers ────────────────────────────────────────
  const [qtyTiers, setQtyTiers]             = useState(initial.quantityDiscount.tiers);
  const [editingQtyTier, setEditingQtyTier] = useState(null);

  // ── UI state ──────────────────────────────────────────────
  const [isDirty, setIsDirty]         = useState(false);
  const [isSaving, setIsSaving]       = useState(false);
  const [saveSuccess, setSaveSuccess] = useState(false);
  const [saveError, setSaveError]     = useState(null);

  stateRef.current = { giftEnabled, giftType, giftItems, giftMinSpend, orderTiers, qtyTiers };

  const markDirty = () => { setIsDirty(true); setSaveError(null); setSaveSuccess(false); };

  // ── Build metafield payload ───────────────────────────────
  const buildPayload = useCallback((snap) => {
    const giftProductIds    = snap.giftItems.filter((i) => i.type === "product").map((i) => i.id);
    const giftCollectionIds = snap.giftItems.filter((i) => i.type === "collection").map((i) => i.id);
    return {
      giftCollectionIds: snap.giftType === "collections" ? giftCollectionIds : [],
      freeGift: {
        enabled:       snap.giftEnabled,
        type:          snap.giftType,
        items:         snap.giftItems,
        productIds:    giftProductIds,
        collectionIds: giftCollectionIds,
        minSpend:      Number(snap.giftMinSpend) || 0,
      },
      orderDiscount:    { tiers: snap.orderTiers },
      quantityDiscount: { tiers: snap.qtyTiers },
    };
  }, []);

  // ── Core save: call applyMetafieldChange with latest state ─
  const doApply = useCallback(async () => {
    const payload = buildPayload(stateRef.current);
    return applyMetafieldChange({
      type:      "updateMetafield",
      namespace: "$app",
      key:       "function-configuration",
      value:     JSON.stringify(payload),
      valueType: "json",
    });
  }, [applyMetafieldChange, buildPayload]);

  // ── Eager staging: keep metafield in sync after each change ──
  useEffect(() => {
    if (!isDirty) return;
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      doApply().catch(() => {});
    }, 500);
    return () => clearTimeout(debounceRef.current);
  }, [giftEnabled, giftType, giftItems, giftMinSpend, orderTiers, qtyTiers, isDirty]);

  // ── Save button handler ───────────────────────────────────
  // 1. Immediately calls applyMetafieldChange (saves or stages)
  // 2. Also dispatches submit on s-function-settings so the native
  //    onSubmit + waitUntil path also fires, committing to Shopify servers
  const handleSaveClick = useCallback(async () => {
    clearTimeout(debounceRef.current);
    setSaveError(null);
    setSaveSuccess(false);
    setIsSaving(true);
    try {
      const result = await doApply();
      if (!result || result.type === "error") {
        const msg = result?.message ?? "Save failed";
        setSaveError(msg);
        return;
      }
      // Also trigger native form submit so Shopify commits via waitUntil
      formRef.current?.dispatchEvent(
        new Event("submit", { bubbles: true, cancelable: true }),
      );
      setIsDirty(false);
      setSaveSuccess(true);
    } catch (err) {
      setSaveError(err?.message ?? "Unexpected error");
    } finally {
      setIsSaving(false);
    }
  }, [doApply]);

  // ── onSubmit handler (native Save bar OR dispatched event) ─
  const handleFormSubmit = useCallback((e) => {
    const promise = doApply().then((result) => {
      if (!result || result.type === "error") {
        throw new Error(result?.message ?? "Save failed");
      }
      setIsDirty(false);
      setSaveSuccess(true);
    });
    if (e?.waitUntil) e.waitUntil(promise);
  }, [doApply]);

  // ── Discard ───────────────────────────────────────────────
  const discardChanges = useCallback(() => {
    clearTimeout(debounceRef.current);
    setGiftEnabled(initial.freeGift.enabled);
    setGiftType(initial.freeGift.type);
    setGiftItems(initial.freeGift.items);
    setGiftMinSpend(initial.freeGift.minSpend > 0 ? String(initial.freeGift.minSpend) : "");
    setOrderTiers(initial.orderDiscount.tiers);
    setQtyTiers(initial.quantityDiscount.tiers);
    setEditingOrderTier(null);
    setEditingQtyTier(null);
    setIsDirty(false);
    setSaveError(null);
    setSaveSuccess(false);
  }, [initial]);

  return (
    <s-function-settings
      ref={formRef}
      onSubmit={handleFormSubmit}
      onReset={discardChanges}
    >

      {/* ── Banners ──────────────────────────────────────────── */}
      {saveError && (
        <s-banner tone="critical">Save failed: {saveError}</s-banner>
      )}
      {saveSuccess && !isDirty && (
        <s-banner tone="success">Settings saved successfully.</s-banner>
      )}

      {/* ═══════════════════════════ FREE GIFT ════════════════ */}
      <s-section>
        <s-stack gap="base">
          <s-stack gap="none">
            <s-text emphasis="bold">Free Gift Configuration</s-text>
            <s-text tone="subdued">
              Offer a free gift when the cart meets a minimum spend threshold.
            </s-text>
          </s-stack>

          <s-checkbox
            checked={giftEnabled}
            onChange={(e) => { setGiftEnabled(e.currentTarget.checked); markDirty(); }}
            label="Enable free gift with qualifying orders"
          />

          {giftEnabled && (
            <s-stack gap="base">
              <s-select
                label="Select gift from"
                value={giftType}
                onChange={(e) => {
                  setGiftType(e.currentTarget.value);
                  setGiftItems([]);
                  markDirty();
                }}
              >
                <s-option value="products">Specific Products</s-option>
                <s-option value="collections">Specific Collections</s-option>
              </s-select>

              <s-box>
                {giftType === "products" ? (
                  <s-button variant="secondary" onClick={pickGiftProducts}>
                    Choose Products
                  </s-button>
                ) : (
                  <s-button variant="secondary" onClick={pickGiftCollections}>
                    Choose Collections
                  </s-button>
                )}
              </s-box>

              {giftItems.length > 0 && (
                <s-stack gap="tight">
                  {giftItems.map((item) => (
                    <s-stack
                      key={item.id}
                      direction="inline"
                      alignItems="center"
                      justifyContent="space-between"
                    >
                      <s-text>
                        {item.type === "collection" ? "📁 " : "📦 "}
                        {item.title}
                      </s-text>
                      <s-button
                        variant="tertiary"
                        onClick={() => {
                          setGiftItems((prev) => prev.filter((i) => i.id !== item.id));
                          markDirty();
                        }}
                      >
                        ✕
                      </s-button>
                    </s-stack>
                  ))}
                </s-stack>
              )}

              <s-number-field
                label="Minimum Spend ($)"
                value={giftMinSpend}
                min={0}
                onChange={(e) => { setGiftMinSpend(e.currentTarget.value); markDirty(); }}
              />
            </s-stack>
          )}
        </s-stack>
      </s-section>

      {/* ═══════════════════════════ ORDER DISCOUNT ═══════════ */}
      <s-section>
        <s-stack gap="base">
          <s-stack gap="none">
            <s-text emphasis="bold">Order Value-Based Discount</s-text>
            <s-text tone="subdued">
              Apply a discount when the cart subtotal exceeds a threshold (e.g. $499, $699, $999).
            </s-text>
          </s-stack>

          <s-box inlineSize="160px">
            <s-button
              onClick={() => setEditingOrderTier({ id: "new", form: { amount: "", discount: "" } })}
            >
              Add Price Rule
            </s-button>
          </s-box>

          {orderTiers.map((tier) =>
            editingOrderTier?.id === tier.id ? (
              <TierEditForm
                key={tier.id}
                amountLabel="Minimum cart value ($)"
                discountLabel="Discount %"
                form={editingOrderTier.form}
                onChange={(form) => setEditingOrderTier((p) => ({ ...p, form }))}
                onSave={() => {
                  setOrderTiers((prev) =>
                    prev.map((t) =>
                      t.id === tier.id
                        ? { id: tier.id, amount: Number(editingOrderTier.form.amount) || 0, discount: Number(editingOrderTier.form.discount) || 0 }
                        : t,
                    ),
                  );
                  setEditingOrderTier(null);
                  markDirty();
                }}
                onCancel={() => setEditingOrderTier(null)}
              />
            ) : (
              <TierListItem
                key={tier.id}
                label={`$${tier.amount} → ${tier.discount}% off`}
                onEdit={() => setEditingOrderTier({ id: tier.id, form: { amount: tier.amount, discount: tier.discount } })}
                onRemove={() => { setOrderTiers((prev) => prev.filter((t) => t.id !== tier.id)); markDirty(); }}
              />
            ),
          )}

          {editingOrderTier?.id === "new" && (
            <TierEditForm
              amountLabel="Minimum cart value ($)"
              discountLabel="Discount %"
              form={editingOrderTier.form}
              onChange={(form) => setEditingOrderTier((p) => ({ ...p, form }))}
              onSave={() => {
                setOrderTiers((prev) => [
                  ...prev,
                  { id: String(Date.now()), amount: Number(editingOrderTier.form.amount) || 0, discount: Number(editingOrderTier.form.discount) || 0 },
                ]);
                setEditingOrderTier(null);
                markDirty();
              }}
              onCancel={() => setEditingOrderTier(null)}
            />
          )}
        </s-stack>
      </s-section>

      {/* ═══════════════════════════ QTY DISCOUNT ════════════ */}
      <s-section>
        <s-stack gap="base">
          <s-stack gap="none">
            <s-text emphasis="bold">Quantity-Based Discount Rule</s-text>
            <s-text tone="subdued">
              Apply a discount based on the total number of items in the cart.
            </s-text>
          </s-stack>

          <s-box inlineSize="180px">
            <s-button
              onClick={() => setEditingQtyTier({ id: "new", form: { qty: "", discount: "" } })}
            >
              Add Quantity Rule
            </s-button>
          </s-box>

          {qtyTiers.map((tier) =>
            editingQtyTier?.id === tier.id ? (
              <TierEditForm
                key={tier.id}
                amountLabel="Minimum items"
                discountLabel="Discount %"
                form={editingQtyTier.form}
                onChange={(form) => setEditingQtyTier((p) => ({ ...p, form }))}
                onSave={() => {
                  setQtyTiers((prev) =>
                    prev.map((t) =>
                      t.id === tier.id
                        ? { id: tier.id, qty: Number(editingQtyTier.form.qty) || 0, discount: Number(editingQtyTier.form.discount) || 0 }
                        : t,
                    ),
                  );
                  setEditingQtyTier(null);
                  markDirty();
                }}
                onCancel={() => setEditingQtyTier(null)}
              />
            ) : (
              <TierListItem
                key={tier.id}
                label={`${tier.qty}+ items → ${tier.discount}% off`}
                onEdit={() => setEditingQtyTier({ id: tier.id, form: { qty: tier.qty, discount: tier.discount } })}
                onRemove={() => { setQtyTiers((prev) => prev.filter((t) => t.id !== tier.id)); markDirty(); }}
              />
            ),
          )}

          {editingQtyTier?.id === "new" && (
            <TierEditForm
              amountLabel="Minimum items"
              discountLabel="Discount %"
              form={editingQtyTier.form}
              onChange={(form) => setEditingQtyTier((p) => ({ ...p, form }))}
              onSave={() => {
                setQtyTiers((prev) => [
                  ...prev,
                  { id: String(Date.now()), qty: Number(editingQtyTier.form.qty) || 0, discount: Number(editingQtyTier.form.discount) || 0 },
                ]);
                setEditingQtyTier(null);
                markDirty();
              }}
              onCancel={() => setEditingQtyTier(null)}
            />
          )}
        </s-stack>
      </s-section>

      {/* ── Save / Discard footer ─────────────────────────────── */}
      {isDirty && (
        <s-section>
          <s-stack gap="base">
            <s-divider />
            <s-stack direction="inline" gap="base">
              <s-button onClick={handleSaveClick} disabled={isSaving}>
                {isSaving ? "Saving…" : "Save"}
              </s-button>
              <s-button variant="secondary" onClick={discardChanges} disabled={isSaving}>
                Discard Changes
              </s-button>
            </s-stack>
          </s-stack>
        </s-section>
      )}

    </s-function-settings>
  );

  async function pickGiftProducts() {
    const currentIds = stateRef.current.giftItems
      .filter((i) => i.type === "product")
      .map((i) => ({ id: i.id }));
    const sel = await resourcePicker({ type: "product", selectionIds: currentIds, action: "select", multiple: true });
    if (sel == null) return;
    setGiftItems(sel.map((p) => ({ id: p.id, title: p.title, type: "product" })));
    markDirty();
  }

  async function pickGiftCollections() {
    const currentIds = stateRef.current.giftItems
      .filter((i) => i.type === "collection")
      .map((i) => ({ id: i.id }));
    const sel = await resourcePicker({ type: "collection", selectionIds: currentIds, action: "select", multiple: true });
    if (sel == null) return;
    setGiftItems(sel.map((c) => ({ id: c.id, title: c.title, type: "collection" })));
    markDirty();
  }
}

function TierListItem({ label, onEdit, onRemove }) {
  return (
    <s-stack direction="inline" alignItems="center" justifyContent="space-between">
      <s-text>{label}</s-text>
      <s-stack direction="inline" gap="tight">
        <s-button variant="secondary" onClick={onEdit}>Edit</s-button>
        <s-button variant="tertiary" onClick={onRemove}>Remove</s-button>
      </s-stack>
    </s-stack>
  );
}

function TierEditForm({ amountLabel, discountLabel, form, onChange, onSave, onCancel }) {
  const amountKey   = "amount" in form ? "amount" : "qty";
  const amountVal   = Number(form[amountKey]);
  const discountVal = Number(form.discount);
  const isValid     = amountVal > 0 && discountVal > 0 && discountVal <= 100;
  return (
    <s-section>
      <s-stack gap="base">
        <s-number-field
          label={amountLabel}
          value={String(form[amountKey] ?? "")}
          min={1}
          onChange={(e) => onChange({ ...form, [amountKey]: e.currentTarget.value })}
        />
        <s-number-field
          label={discountLabel}
          value={String(form.discount ?? "")}
          min={1}
          max={100}
          suffix="%"
          onChange={(e) => onChange({ ...form, discount: e.currentTarget.value })}
        />
        <s-stack direction="inline" gap="base">
          <s-button onClick={onSave} disabled={!isValid}>Save Rule</s-button>
          <s-button variant="secondary" onClick={onCancel}>Cancel</s-button>
        </s-stack>
        {!isValid && (form[amountKey] !== "" || form.discount !== "") && (
          <s-text tone="critical">Both fields must be greater than 0 (discount max 100%).</s-text>
        )}
      </s-stack>
    </s-section>
  );
}

function parseConfig(value) {
  try {
    const p = JSON.parse(value || "{}");
    return {
      freeGift: {
        enabled:  Boolean(p.freeGift?.enabled),
        type:     p.freeGift?.type === "collections" ? "collections" : "products",
        items:    Array.isArray(p.freeGift?.items) ? p.freeGift.items : [],
        minSpend: Number(p.freeGift?.minSpend ?? 0),
      },
      orderDiscount: {
        tiers: Array.isArray(p.orderDiscount?.tiers)
          ? p.orderDiscount.tiers.map((t) => ({
              id:       t.id ?? String(Math.random()),
              amount:   Number(t.amount ?? 0),
              discount: Number(t.discount ?? 0),
            }))
          : [],
      },
      quantityDiscount: {
        tiers: Array.isArray(p.quantityDiscount?.tiers)
          ? p.quantityDiscount.tiers.map((t) => ({
              id:       t.id ?? String(Math.random()),
              qty:      Number(t.qty ?? 0),
              discount: Number(t.discount ?? 0),
            }))
          : [],
      },
    };
  } catch {
    return {
      freeGift:         { enabled: false, type: "products", items: [], minSpend: 0 },
      orderDiscount:    { tiers: [] },
      quantityDiscount: { tiers: [] },
    };
  }
}
