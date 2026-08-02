import assert from "node:assert/strict";
import test from "node:test";

import {
  draftFromParser,
  receiptDraftLineValue,
} from "../app/receipt-review-flow.tsx";

test("the review draft preserves an extracted product discount through save", () => {
  const draft = draftFromParser({
    purchasedAt: "2026-08-01",
    subtotalCents: 6800,
    taxCents: 0,
    totalCents: 6800,
    discountCents: 1200,
    items: [
      {
        itemNumber: "1868328",
        rawDescription: "3 DOT PANT",
        quantityMilli: 1000,
        unitPriceCents: 8000,
        lineSubtotalCents: 8000,
        discountCents: 1200,
        netAmountCents: 6800,
        kind: "item",
        taxStatus: "non_taxable",
      },
    ],
  });

  assert.equal(draft.items[0].amount, "68.00");
  assert.equal(draft.items[0].discountCents, 1200);
  assert.deepEqual(receiptDraftLineValue(draft.items[0], 0), {
    sourceLineNumber: 1,
    costcoItemNumber: "1868328",
    rawDescription: "3 DOT PANT",
    quantityMilli: 1000,
    unitPriceCents: 8000,
    lineSubtotalCents: 8000,
    netAmountCents: 6800,
    discountCents: 1200,
    taxStatus: "non_taxable",
    kind: "item",
  });
});

test("a manually marked discount saves as negative evidence, not a product", () => {
  const saved = receiptDraftLineValue(
    {
      clientId: "discount-line",
      itemNumber: "",
      description: "INSTANT SAVINGS",
      amount: "2.00",
      quantityMilli: 1000,
      unitPriceCents: null,
      discountCents: 0,
      kind: "discount",
      taxStatus: "non_taxable",
    },
    1,
  );

  assert.equal(saved.kind, "discount");
  assert.equal(saved.lineSubtotalCents, 0);
  assert.equal(saved.discountCents, 200);
  assert.equal(saved.netAmountCents, -200);
});

test("the review draft aligns an OCR year error to the active trip date", () => {
  const draft = draftFromParser(
    {
      purchasedAt: "2020-08-01",
      subtotalCents: 1000,
      taxCents: 0,
      totalCents: 1000,
      discountCents: 0,
      items: [],
    },
    "2026-08-01",
  );

  assert.equal(draft.purchasedOn, "2026-08-01");
});
