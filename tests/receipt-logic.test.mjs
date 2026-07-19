import assert from "node:assert/strict";
import test from "node:test";

import {
  buildReviewQuestionCandidates,
  buildTripComparison,
  matchReceiptItemsToIntent,
  normalizeReceiptDescription,
  parseCostcoOcrText,
  reconcileReceipt,
} from "../app/receipt-logic.ts";

test("normalizes and parses common Costco milk and cucumber lines", () => {
  assert.equal(normalizeReceiptDescription("  mini-cukes™  "), "MINI CUKES");

  const draft = parseCostcoOcrText(`
1234567 KS ORG 2% MK 13.99
MINI CUKES 6.49
SUBTOTAL 20.48
TAX 0.00
TOTAL 20.48
  `);

  assert.equal(draft.items.length, 2);
  assert.deepEqual(
    draft.items.map((item) => ({
      itemNumber: item.costcoItemNumber,
      description: item.rawDescription,
      amount: item.netAmountCents,
    })),
    [
      { itemNumber: "1234567", description: "KS ORG 2% MK", amount: 1399 },
      { itemNumber: null, description: "MINI CUKES", amount: 649 },
    ],
  );
  assert.equal(draft.subtotalCents, 2048);
  assert.equal(draft.taxCents, 0);
  assert.equal(draft.totalCents, 2048);
});

test("does not invent ambiguous OCR amounts and flags comma normalization", () => {
  const draft = parseCostcoOcrText(`
KS ORG 2% MK 1399
MINI CUKES 6,49
SUBTOTAL 6,49
TOTAL 6,49
  `);

  assert.equal(draft.items.length, 1);
  assert.equal(draft.items[0].rawDescription, "MINI CUKES");
  assert.equal(draft.items[0].netAmountCents, 649);
  assert.ok(draft.warnings.some((warning) => warning.code === "ambiguous_amount"));
  assert.ok(
    draft.warnings.some(
      (warning) => warning.code === "decimal_separator_normalized",
    ),
  );
});

test("parses coupon lines and returns as distinct negative evidence", () => {
  const draft = parseCostcoOcrText(`
1234567 KS ORG 2% MK 13.99
INSTANT SAVINGS 2.00-
7654321 SHIRT 9.99-
SUBTOTAL 2.00
TAX 0.00
TOTAL 2.00
  `);

  const discount = draft.items.find((item) => item.kind === "discount");
  const returnedItem = draft.items.find((item) => item.isReturn);
  assert.ok(discount);
  assert.equal(discount.discountCents, 200);
  assert.equal(discount.netAmountCents, -200);
  assert.ok(returnedItem);
  assert.equal(returnedItem.rawDescription, "SHIRT");
  assert.equal(returnedItem.netAmountCents, -999);
  assert.equal(draft.discountCents, 200);

  const reconciliation = reconcileReceipt({
    items: draft.items,
    subtotalCents: draft.subtotalCents,
    taxCents: draft.taxCents,
    totalCents: draft.totalCents,
    discountCents: draft.discountCents,
  });
  assert.equal(reconciliation.itemNetCents, 200);
  assert.equal(reconciliation.isReconciled, true);
});

test("parses explicit quantity and validates the printed line total", () => {
  const draft = parseCostcoOcrText(`
1234567 MINI CUKES 2 @ 6.49 12.98
SUBTOTAL 12.98
TAX 0.00
TOTAL 12.98
  `);

  assert.equal(draft.items.length, 1);
  assert.equal(draft.items[0].quantityMilli, 2000);
  assert.equal(draft.items[0].unitPriceCents, 649);
  assert.equal(draft.items[0].lineSubtotalCents, 1298);
  assert.equal(
    draft.warnings.some((warning) => warning.code === "quantity_total_mismatch"),
    false,
  );
});

test("uses a strict inclusive five-cent arithmetic threshold", () => {
  const atBoundary = reconcileReceipt({
    items: [{ netAmountCents: 1000 }],
    subtotalCents: 995,
    taxCents: 5,
    totalCents: 1000,
  });
  assert.equal(atBoundary.subtotalDeltaCents, 5);
  assert.equal(atBoundary.totalDeltaCents, 0);
  assert.equal(atBoundary.isReconciled, true);

  const outsideBoundary = reconcileReceipt({
    items: [{ netAmountCents: 1000 }],
    subtotalCents: 994,
    taxCents: 6,
    totalCents: 1000,
  });
  assert.equal(outsideBoundary.subtotalDeltaCents, 6);
  assert.equal(outsideBoundary.isReconciled, false);
  assert.match(outsideBoundary.explanations.at(-1), /remains provisional/i);
});

test("never treats a generic category as a product match", () => {
  const result = matchReceiptItemsToIntent({
    intentItems: [{ id: "intent-fruit", label: "Fruit", quantityMilli: 1000 }],
    receiptItems: [
      {
        id: "receipt-lychee",
        rawDescription: "Lychee",
        quantityMilli: 1000,
        netAmountCents: 799,
      },
    ],
  });

  assert.deepEqual(result.matches, []);
  assert.deepEqual(result.unmatchedIntentItemIds, ["intent-fruit"]);
  assert.deepEqual(result.unmatchedReceiptItemIds, ["receipt-lychee"]);
});

test("a confirmed household alias creates a high-confidence automatic match", () => {
  const result = matchReceiptItemsToIntent({
    intentItems: [
      {
        id: "intent-milk",
        productId: "product-milk",
        label: "Kirkland organic 2% milk",
      },
    ],
    receiptItems: [
      {
        id: "receipt-milk",
        rawDescription: "KS ORG 2% MK",
        netAmountCents: 1399,
      },
    ],
    aliases: [
      {
        alias: "KS ORG 2% MK",
        productId: "product-milk",
        confirmed: true,
      },
    ],
  });

  assert.equal(result.matches.length, 1);
  assert.equal(result.matches[0].reason, "confirmed_alias");
  assert.equal(result.matches[0].confidenceBps, 9900);
  assert.equal(result.matches[0].status, "auto_matched");
});

test("fuzzy name similarity can suggest a candidate but never auto-confirms it", () => {
  const result = matchReceiptItemsToIntent({
    intentItems: [{ id: "intent-milk", label: "Organic whole milk" }],
    receiptItems: [
      {
        id: "receipt-milk",
        rawDescription: "Organic milk",
        netAmountCents: 1299,
      },
    ],
  });

  assert.equal(result.matches.length, 1);
  assert.equal(result.matches[0].reason, "fuzzy_candidate");
  assert.equal(result.matches[0].status, "candidate");
  assert.ok(result.matches[0].confidenceBps < 9300);
});

test("matching allocates each receipt line once and uses quantity as a tie-breaker", () => {
  const result = matchReceiptItemsToIntent({
    intentItems: [
      {
        id: "one-milk",
        costcoItemNumber: "1234567",
        label: "Milk",
        quantityMilli: 1000,
      },
      {
        id: "two-milks",
        costcoItemNumber: "1234567",
        label: "Milk",
        quantityMilli: 2000,
      },
    ],
    receiptItems: [
      {
        id: "receipt-milk",
        costcoItemNumber: "1234567",
        rawDescription: "KS ORG 2% MK",
        quantityMilli: 2000,
        netAmountCents: 2798,
      },
    ],
  });

  assert.equal(result.matches.length, 1);
  assert.equal(result.matches[0].intentItemId, "two-milks");
  assert.equal(result.matches[0].quantityRatioBps, 10000);
  assert.deepEqual(result.unmatchedIntentItemIds, ["one-milk"]);
});

test("comparison uses neutral receipt-only language and keeps bridge components separate", () => {
  const comparison = buildTripComparison({
    intentItems: [
      {
        id: "milk-plan",
        label: "Milk",
        section: "essentials",
        includedAtFreeze: true,
        estimatedPriceCents: 1299,
      },
    ],
    receiptItems: [
      {
        id: "milk-actual",
        rawDescription: "Milk",
        netAmountCents: 1399,
      },
      {
        id: "lychee-actual",
        rawDescription: "Lychee",
        netAmountCents: 1799,
      },
      {
        id: "coupon",
        rawDescription: "Instant savings",
        kind: "discount",
        discountCents: 200,
        netAmountCents: -200,
      },
    ],
    matches: [
      {
        intentItemId: "milk-plan",
        receiptItemId: "milk-actual",
        status: "auto_matched",
        confidenceBps: 9400,
        reason: "normalized_exact",
        expectedQuantityMilli: 1000,
        actualQuantityMilli: 1000,
        quantityRatioBps: 10000,
      },
    ],
    estimatedTotalCents: 1299,
    actualTotalCents: 2998,
    discountCents: 200,
    taxCents: 0,
  });

  assert.equal(comparison.buckets.savedAndPurchased.length, 1);
  assert.equal(comparison.buckets.receiptOnlyAdditions.length, 1);
  assert.equal(
    comparison.buckets.receiptOnlyAdditions[0].receiptItem.rawDescription,
    "Lychee",
  );
  assert.equal(comparison.bridge.priceAndQuantityVarianceCents, 100);
  assert.equal(comparison.bridge.receiptOnlyAdditionsCents, 1799);
  assert.equal(comparison.bridge.discountsCents, 200);
  assert.doesNotMatch(JSON.stringify(comparison), /impulse/i);
});

test("review questions are evidence-triggered, deterministic, and capped at three", () => {
  const intentItems = [
    {
      id: "milk-missing",
      label: "Milk",
      section: "essentials",
      includedAtFreeze: true,
      estimatedPriceCents: 1399,
    },
    {
      id: "cucumbers-plan",
      label: "Mini cucumbers",
      section: "essentials",
      includedAtFreeze: true,
      estimatedPriceCents: 649,
    },
  ];
  const receiptItems = [
    {
      id: "cukes-actual",
      rawDescription: "Mini cukes",
      netAmountCents: 649,
    },
    {
      id: "jacket-actual",
      rawDescription: "Kids jacket",
      netAmountCents: 2499,
    },
    {
      id: "unclear-line",
      rawDescription: "O0O III",
      netAmountCents: 899,
      parseConfidenceBps: 5000,
    },
  ];
  const comparison = buildTripComparison({
    intentItems,
    receiptItems,
    matches: [
      {
        intentItemId: "cucumbers-plan",
        receiptItemId: "cukes-actual",
        status: "candidate",
        confidenceBps: 8000,
        reason: "fuzzy_candidate",
        expectedQuantityMilli: 1000,
        actualQuantityMilli: 1000,
        quantityRatioBps: 10000,
      },
    ],
    estimatedTotalCents: 2048,
    actualTotalCents: 4047,
  });

  const questions = buildReviewQuestionCandidates({
    comparison,
    isReconciled: false,
    receiptTotalCents: 4047,
    parseWarnings: [
      {
        code: "ambiguous_item",
        lineNumber: 8,
        rawLine: "O0O III 8.99",
        message: "Needs review",
      },
    ],
  });

  assert.equal(questions.length, 3);
  assert.deepEqual(
    questions.map((question) => question.priority),
    [0, 10, 20],
  );
  assert.deepEqual(
    questions.map((question) => question.kind),
    ["data_quality", "data_quality", "behavioral"],
  );
  for (const question of questions) {
    assert.ok(question.purpose.length > 0);
    assert.ok(question.effectTarget.length > 0);
    assert.ok(question.options.length >= 2);
    assert.ok(question.options.every((option) => option.effect.length > 0));
  }

  const receiptOnlyQuestion = buildReviewQuestionCandidates({
    comparison: buildTripComparison({
      intentItems: [],
      receiptItems: [
        {
          id: "lychee",
          rawDescription: "Lychee",
          netAmountCents: 1600,
        },
      ],
      matches: [],
      actualTotalCents: 1600,
    }),
    isReconciled: true,
    receiptTotalCents: 1600,
  });
  assert.equal(receiptOnlyQuestion.length, 1);
  assert.equal(receiptOnlyQuestion[0].id, "receipt-only-lychee");
  assert.match(receiptOnlyQuestion[0].prompt, /not on the saved plan/i);
});
