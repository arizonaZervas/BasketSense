import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  comparisonExpectedCents,
  draftFromParser,
  receiptDraftLineValue,
  receiptDraftLineValueForTransaction,
} from "../app/receipt-review-flow.tsx";

test("checkout uses the final shopping-list estimate while preserving initial intent", () => {
  const comparison = {
    frozenEstimateCents: 15000,
    finalListEstimateCents: 25000,
    actualTotalCents: 30900,
  };
  const expectedCents = comparisonExpectedCents(comparison);
  assert.equal(expectedCents, 25000);
  assert.equal(comparison.actualTotalCents - expectedCents, 5900);
  assert.equal(comparison.frozenEstimateCents, 15000);
});

test("checkout comparison explains both the initial and final list estimates", async () => {
  const source = await readFile(
    new URL("../app/receipt-review-flow.tsx", import.meta.url),
    "utf8",
  );
  assert.match(source, /final shopping-list estimate/);
  assert.match(source, /Started at/);
  assert.match(source, /shopping changes brought the list to/);
  assert.match(source, />Final list</);
  assert.match(source, /Includes shopping changes/);
  assert.match(source, /unpriced.*not included/);
});

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

test("return review displays refund magnitudes but saves signed negative product lines", () => {
  const draft = draftFromParser(
    {
      purchasedAt: "2026-08-15",
      subtotalCents: -1500,
      taxCents: 0,
      totalCents: -1500,
      items: [
        {
          itemNumber: "1868328",
          rawDescription: "RETURNED PRODUCT",
          quantityMilli: 1000,
          unitPriceCents: -1500,
          lineSubtotalCents: -1500,
          netAmountCents: -1500,
          discountCents: 0,
        },
      ],
    },
    null,
    "return",
  );

  assert.equal(draft.transactionType, "return");
  assert.equal(draft.subtotal, "15.00");
  assert.equal(draft.total, "15.00");
  assert.equal(draft.items[0].amount, "15.00");
  assert.deepEqual(
    receiptDraftLineValueForTransaction(draft.items[0], 0, "return"),
    {
      sourceLineNumber: 1,
      costcoItemNumber: "1868328",
      rawDescription: "RETURNED PRODUCT",
      quantityMilli: 1000,
      unitPriceCents: -1500,
      lineSubtotalCents: -1500,
      netAmountCents: -1500,
      discountCents: 0,
      taxStatus: "unknown",
      kind: "item",
    },
  );
});
