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

test("attaches Costco instant savings to the preceding product paid price", () => {
  const draft = parseCostcoOcrText(`
1234567 KS ORG 2% MK 13.99
INSTANT SAVINGS 2.00-
7654321 SHIRT 9.99-
SUBTOTAL 2.00
TAX 0.00
TOTAL 2.00
  `);

  const discountedMilk = draft.items.find(
    (item) => item.costcoItemNumber === "1234567",
  );
  const returnedItem = draft.items.find((item) => item.isReturn);
  assert.ok(discountedMilk);
  assert.equal(discountedMilk.lineSubtotalCents, 1399);
  assert.equal(discountedMilk.discountCents, 200);
  assert.equal(discountedMilk.netAmountCents, 1199);
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

test("keeps a receipt-level reward separate from the preceding product", () => {
  const draft = parseCostcoOcrText(`
1234567 KS ORG 2% MK 13.99
EXECUTIVE REWARD 2.00-
SUBTOTAL 11.99
TAX 0.00
TOTAL 11.99
  `);

  assert.equal(draft.items.length, 2);
  assert.equal(draft.items[0].discountCents, 0);
  assert.equal(draft.items[1].kind, "discount");
  assert.equal(draft.items[1].discountCents, 200);
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

test("reconciles an online order whose discount is applied after the printed subtotal", () => {
  const result = reconcileReceipt({
    items: [
      {
        lineSubtotalCents: 127196,
        discountCents: 8000,
        netAmountCents: 119196,
      },
      { lineSubtotalCents: 2000, netAmountCents: 2000 },
      { lineSubtotalCents: 1196, netAmountCents: 1196 },
      { lineSubtotalCents: 900, netAmountCents: 900 },
      { lineSubtotalCents: 0, netAmountCents: 0 },
    ],
    subtotalCents: 131292,
    discountCents: 8000,
    taxCents: 9584,
    totalCents: 132876,
  });

  assert.equal(result.itemNetCents, 123292);
  assert.equal(result.subtotalUsesGrossItemCents, true);
  assert.equal(result.totalUsesReceiptDiscount, true);
  assert.equal(result.subtotalDeltaCents, 0);
  assert.equal(result.totalDeltaCents, 0);
  assert.equal(result.isReconciled, true);
});

test("does not subtract a discount twice when a warehouse subtotal is already net", () => {
  const result = reconcileReceipt({
    items: [
      {
        lineSubtotalCents: 8000,
        discountCents: 1200,
        netAmountCents: 6800,
      },
    ],
    subtotalCents: 6800,
    discountCents: 1200,
    taxCents: 0,
    totalCents: 6800,
  });

  assert.equal(result.subtotalUsesGrossItemCents, false);
  assert.equal(result.totalUsesReceiptDiscount, false);
  assert.equal(result.subtotalDeltaCents, 0);
  assert.equal(result.totalDeltaCents, 0);
  assert.equal(result.isReconciled, true);
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

test("an explicit household fulfillment is remembered without catalog identity", () => {
  const result = matchReceiptItemsToIntent({
    intentItems: [{ id: "intent-ziploc", label: "Ziploc bags" }],
    receiptItems: [{
      id: "receipt-ziploc",
      costcoItemNumber: "1234567",
      rawDescription: "ZIPLC SLIDER",
      netAmountCents: 1499,
    }],
    fulfillments: [{
      intentKey: "intent:ZIPLOC BAGS",
      receiptKey: "item:1234567",
      relation: "fulfills_intent",
      confidenceBps: 10000,
    }],
  });

  assert.equal(result.matches.length, 1);
  assert.equal(result.matches[0].status, "auto_matched");
  assert.equal(result.matches[0].reason, "confirmed_intent_fulfillment");
});

for (const [relation, reason] of [
  ["same_product", "confirmed_same_product"],
  ["substitute", "confirmed_substitute"],
]) {
  test(`an explicit ${relation} decision becomes a high-confidence automatic match`, () => {
    const result = matchReceiptItemsToIntent({
      intentItems: [{ id: "intent-bags", label: "Food storage bags" }],
      receiptItems: [{ id: "receipt-bags", rawDescription: "ZIPLC SLIDER" }],
      fulfillments: [{
        intentKey: "intent:FOOD STORAGE BAGS",
        receiptKey: "description:ZIPLOC BAGS",
        relation,
        confidenceBps: 10000,
      }],
    });

    assert.equal(result.matches.length, 1);
    assert.equal(result.matches[0].status, "auto_matched");
    assert.equal(result.matches[0].reason, reason);
  });
}

test("an explicit not-same decision suppresses that intent and receipt pair", () => {
  const result = matchReceiptItemsToIntent({
    intentItems: [{ id: "intent-suja", label: "Suja" }],
    receiptItems: [{
      id: "receipt-suja",
      rawDescription: "SUJA DIGESTION",
      netAmountCents: 1269,
    }],
    fulfillments: [{
      intentKey: "intent:SUJA",
      receiptKey: "description:SUJA DIGESTION",
      relation: "not_same",
      confidenceBps: 10000,
    }],
  });

  assert.deepEqual(result.matches, []);
});

test("AI product understanding may suggest a match but cannot auto-confirm it", () => {
  const result = matchReceiptItemsToIntent({
    intentItems: [{ id: "intent-ziploc", label: "Ziploc bags" }],
    receiptItems: [{
      id: "receipt-ziploc",
      rawDescription: "UNRELATED PRINTED LABEL",
      canonicalName: "Ziploc bags",
      canonicalNameAdvisory: true,
      netAmountCents: 1499,
    }],
  });

  assert.equal(result.matches.length, 1);
  assert.equal(result.matches[0].status, "candidate");
  assert.equal(result.matches[0].confidenceBps, 9200);
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

test("a productless planned estimate stays planned and reports its estimated-item difference", () => {
  const intentItems = [
    {
      id: "rice-plan",
      productId: null,
      label: "Rice",
      section: "essentials",
      includedAtFreeze: true,
      estimatedPriceCents: 2400,
      quantityMilli: 1000,
    },
  ];
  const receiptItems = [
    {
      id: "rice-actual",
      productId: null,
      rawDescription: "RICE",
      quantityMilli: 1000,
      netAmountCents: 2700,
    },
  ];
  const matchResult = matchReceiptItemsToIntent({
    intentItems,
    receiptItems,
  });
  assert.equal(matchResult.matches.length, 1);

  const comparison = buildTripComparison({
    intentItems,
    receiptItems,
    matches: matchResult.matches,
    estimatedTotalCents: 2400,
    actualTotalCents: 2700,
  });

  assert.equal(comparison.buckets.savedAndPurchased.length, 1);
  assert.equal(comparison.buckets.receiptOnlyAdditions.length, 0);
  assert.equal(comparison.bridge.priceAndQuantityVarianceCents, 300);
});

test("matches household shorthand to receipt wording without a catalog product", () => {
  const result = matchReceiptItemsToIntent({
    intentItems: [
      { id: "atta-plan", label: "Atta", includedAtFreeze: true },
      { id: "rice-plan", label: "Rice", includedAtFreeze: true },
    ],
    receiptItems: [
      { id: "flour-receipt", rawDescription: "WHEAT FLOUR", netAmountCents: 1379 },
      {
        id: "rice-receipt",
        rawDescription: "BASMATI RICE",
        canonicalName: "Royal basmati rice, 20 lb",
        netAmountCents: 1999,
      },
    ],
  });

  assert.deepEqual(
    result.matches.map((match) => [match.intentItemId, match.receiptItemId, match.reason]),
    [
      ["atta-plan", "flour-receipt", "normalized_exact"],
      ["rice-plan", "rice-receipt", "descriptive_subset"],
    ],
  );
  assert.deepEqual(result.unmatchedIntentItemIds, []);
  assert.deepEqual(result.unmatchedReceiptItemIds, []);
});

test("matches Costco's WATR abbreviation to a live coconut-water list item", () => {
  const result = matchReceiptItemsToIntent({
    intentItems: [
      { id: "coconut-water-live", label: "Coconut water", addedAfterFreeze: true },
    ],
    receiptItems: [
      {
        id: "coconut-water-receipt",
        rawDescription: "COCONUT WATR",
        canonicalName: "COCONUT WATR",
        netAmountCents: 2299,
      },
    ],
  });

  assert.deepEqual(
    result.matches.map((match) => [match.intentItemId, match.receiptItemId, match.status]),
    [["coconut-water-live", "coconut-water-receipt", "auto_matched"]],
  );
  assert.deepEqual(result.unmatchedReceiptItemIds, []);
});

test("matches common household wording to compact Costco receipt labels", () => {
  const result = matchReceiptItemsToIntent({
    intentItems: [
      { id: "ziploc-plan", label: "Zip loc bags", includedAtFreeze: true },
      { id: "suja-plan", label: "Suja digestion", includedAtFreeze: true },
      { id: "cupcakes-plan", label: "Cup cakes", includedAtFreeze: true },
    ],
    receiptItems: [
      { id: "ziploc-receipt", rawDescription: "ZIPLC SLIDER", netAmountCents: 1499 },
      { id: "suja-receipt", rawDescription: "SUJADIGSTION", netAmountCents: 1269 },
      { id: "cupcakes-receipt", rawDescription: "CUPCAKES", netAmountCents: 1599 },
    ],
  });

  assert.deepEqual(
    result.matches.map((match) => [match.intentItemId, match.receiptItemId, match.status]),
    [
      ["cupcakes-plan", "cupcakes-receipt", "auto_matched"],
      ["suja-plan", "suja-receipt", "auto_matched"],
      ["ziploc-plan", "ziploc-receipt", "auto_matched"],
    ],
  );
});

test("matches the exact singular household wording from the sandbox receipt", () => {
  const result = matchReceiptItemsToIntent({
    intentItems: [
      { id: "ziploc-plan", label: "Ziploc bag", includedAtFreeze: true },
      { id: "suja-plan", label: "Suja shots", includedAtFreeze: true },
    ],
    receiptItems: [
      {
        id: "ziploc-receipt",
        costcoItemNumber: "1897234",
        rawDescription: "ZIPLC SLIDER",
        canonicalName: "Ziploc Slider Storage Bags",
        netAmountCents: 1499,
      },
      {
        id: "suja-receipt",
        productId: "suja-digestion-product",
        costcoItemNumber: "1847239",
        rawDescription: "SUJADIGSTION",
        canonicalName: "Suja Organic Digestion Shot",
        semanticCanonicalName: "Suja Organic Digestion Shot",
        semanticBrand: "Suja",
        semanticProductFamily: "Juice & Wellness Shots",
        semanticVariant: "Digestion",
        semanticAliases: ["Suja Digestion", "wellness shot"],
        semanticConfidenceBps: 9500,
        semanticExactSkuKnown: true,
        netAmountCents: 1269,
      },
    ],
  });

  assert.deepEqual(
    result.matches.map((match) => [
      match.intentItemId,
      match.receiptItemId,
      match.status,
      match.reason,
    ]),
    [
      ["ziploc-plan", "ziploc-receipt", "auto_matched", "normalized_exact"],
      ["suja-plan", "suja-receipt", "auto_matched", "semantic_fulfillment"],
    ],
  );
  assert.deepEqual(result.unmatchedIntentItemIds, []);
  assert.deepEqual(result.unmatchedReceiptItemIds, []);
});

test("does not promote a broad intent from an advisory AI name alone", () => {
  const result = matchReceiptItemsToIntent({
    intentItems: [{ id: "suja-plan", label: "Suja shots", includedAtFreeze: true }],
    receiptItems: [{
      id: "suja-receipt",
      rawDescription: "UNRELATED PRINTED LABEL",
      canonicalName: "Suja Organic Digestion Shot",
      canonicalNameAdvisory: true,
      netAmountCents: 1269,
    }],
  });

  assert.equal(result.matches.length, 1);
  assert.equal(result.matches[0].status, "candidate");
  assert.equal(result.matches[0].reason, "fuzzy_candidate");
});

test("a trusted LLM semantic alias can fulfill intent when the printed label is opaque", () => {
  const result = matchReceiptItemsToIntent({
    intentItems: [{ id: "bags-plan", label: "Food storage bags" }],
    receiptItems: [{
      id: "bags-receipt",
      costcoItemNumber: "1897234",
      rawDescription: "OPAQUE COSTCO LABEL",
      semanticCanonicalName: "Ziploc Slider Storage Bags",
      semanticBrand: "Ziploc",
      semanticProductFamily: "Food Storage Bags",
      semanticVariant: "Slider",
      semanticAliases: ["storage bags", "Ziploc bags"],
      semanticConfidenceBps: 9500,
      semanticExactSkuKnown: true,
    }],
  });

  assert.deepEqual(
    result.matches.map((match) => [match.status, match.reason, match.confidenceBps]),
    [["auto_matched", "semantic_fulfillment", 9350]],
  );
});

test("trusted product understanding resolves Downy Fresh from an opaque Costco label", () => {
  const result = matchReceiptItemsToIntent({
    intentItems: [{ id: "downy-plan", label: "Downy Fresh" }],
    receiptItems: [{
      id: "downy-receipt",
      costcoItemNumber: "5161251",
      rawDescription: "UNSTPBL FRSH",
      semanticCanonicalName: "Downy Unstopables Fresh In-Wash Scent Booster Beads",
      semanticBrand: "Downy",
      semanticProductFamily: "Laundry scent booster beads",
      semanticVariant: "Fresh",
      semanticAliases: ["Downy Fresh", "Downy Unstopables Fresh"],
      semanticIntentAliases: ["laundry scent booster", "scent booster beads"],
      semanticConfidenceBps: 9700,
      semanticExactSkuKnown: false,
    }],
  });
  assert.deepEqual(
    result.matches.map((match) => [match.status, match.reason]),
    [["auto_matched", "semantic_fulfillment"]],
  );
});

test("a trusted intent alias lets Naked White fulfill the generic bread plan", () => {
  const result = matchReceiptItemsToIntent({
    intentItems: [{ id: "bread-plan", label: "bread" }],
    receiptItems: [{
      id: "bread-receipt",
      costcoItemNumber: "1860779",
      rawDescription: "NAKED WHITE",
      semanticCanonicalName: "Naked White Bread",
      semanticBrand: "Naked Bread",
      semanticProductFamily: "Bread",
      semanticVariant: "White",
      semanticAliases: ["Naked White", "white sandwich bread"],
      semanticIntentAliases: ["bread", "white bread"],
      semanticConfidenceBps: 9600,
      semanticExactSkuKnown: false,
    }],
  });
  assert.deepEqual(
    result.matches.map((match) => [match.status, match.reason]),
    [["auto_matched", "semantic_fulfillment"]],
  );
});

test("an unseen trusted family intent resolves opaque dishwasher tabs", () => {
  const result = matchReceiptItemsToIntent({
    intentItems: [{ id: "tabs-plan", label: "dishwasher tabs" }],
    receiptItems: [{
      id: "tabs-receipt",
      costcoItemNumber: "synthetic-1",
      rawDescription: "DW TABS LEMON",
      semanticCanonicalName: "Lemon Dishwasher Detergent Tablets",
      semanticProductFamily: "Dishwasher detergent tablets",
      semanticIntentAliases: ["dishwasher tabs", "dishwasher detergent"],
      semanticConfidenceBps: 9500,
      semanticExactSkuKnown: true,
    }],
  });
  assert.equal(result.matches[0]?.status, "auto_matched");
  assert.equal(result.matches[0]?.reason, "semantic_fulfillment");
});

test("a broad intent shared by two receipt products remains reviewable", () => {
  const result = matchReceiptItemsToIntent({
    intentItems: [{ id: "bread-plan", label: "bread" }],
    receiptItems: ["white", "wheat"].map((variant) => ({
      id: `${variant}-receipt`,
      costcoItemNumber: `${variant}-sku`,
      rawDescription: `${variant.toUpperCase()} OPAQUE`,
      semanticCanonicalName: `${variant} sandwich bread`,
      semanticProductFamily: "Bread",
      semanticIntentAliases: ["bread"],
      semanticConfidenceBps: 9600,
      semanticExactSkuKnown: true,
    })),
  });
  assert.equal(result.matches.length, 1);
  assert.equal(result.matches[0].status, "candidate");
});

test("ambiguous semantic candidates stay reviewable instead of using ID order", () => {
  const receiptItem = {
    id: "suja-receipt",
    costcoItemNumber: "1847239",
    rawDescription: "SUJADIGSTION",
    semanticCanonicalName: "Suja Organic Digestion Shot",
    semanticBrand: "Suja",
    semanticProductFamily: "Juice & Wellness Shots",
    semanticVariant: "Digestion",
    semanticAliases: ["Suja Digestion", "wellness shots"],
    semanticConfidenceBps: 9500,
    semanticExactSkuKnown: true,
  };
  for (const intentItems of [
    [
      { id: "a-suja", label: "Suja shots" },
      { id: "z-juice", label: "Juice shots" },
    ],
    [
      { id: "z-suja", label: "Suja shots" },
      { id: "a-juice", label: "Juice shots" },
    ],
  ]) {
    const result = matchReceiptItemsToIntent({ intentItems, receiptItems: [receiptItem] });
    assert.equal(result.matches.length, 1);
    assert.equal(result.matches[0].status, "candidate");
    assert.equal(result.matches[0].reason, "semantic_fulfillment");
  }
});

test("generic one-token semantic intents remain review-only", () => {
  for (const label of ["shots", "bags"]) {
    const result = matchReceiptItemsToIntent({
      intentItems: [{ id: `plan-${label}`, label }],
      receiptItems: [{
        id: `receipt-${label}`,
        costcoItemNumber: `sku-${label}`,
        rawDescription: "OPAQUE COSTCO LABEL",
        semanticCanonicalName:
          label === "shots" ? "Suja Organic Digestion Shot" : "Ziploc Slider Storage Bags",
        semanticProductFamily:
          label === "shots" ? "Juice & Wellness Shots" : "Food Storage Bags",
        semanticConfidenceBps: 9500,
        semanticExactSkuKnown: true,
      }],
    });
    assert.equal(result.matches.length, 1);
    assert.equal(result.matches[0].status, "candidate");
  }
});

test("unverified semantic evidence remains a reviewable candidate", () => {
  const result = matchReceiptItemsToIntent({
    intentItems: [{ id: "bags-plan", label: "Food storage bags" }],
    receiptItems: [{
      id: "bags-receipt",
      costcoItemNumber: "unknown-sku",
      rawDescription: "OPAQUE COSTCO LABEL",
      semanticProductFamily: "Food Storage Bags",
      semanticConfidenceBps: 9100,
      semanticExactSkuKnown: false,
    }],
  });

  assert.deepEqual(
    result.matches.map((match) => [match.status, match.reason, match.confidenceBps]),
    [["candidate", "fuzzy_candidate", 9200]],
  );
});

test("semantic family matching does not erase a conflicting product variant", () => {
  const result = matchReceiptItemsToIntent({
    intentItems: [{ id: "suja-plan", label: "Suja Ginger Shots" }],
    receiptItems: [{
      id: "suja-receipt",
      costcoItemNumber: "1847239",
      rawDescription: "SUJADIGSTION",
      semanticCanonicalName: "Suja Organic Digestion Shot",
      semanticBrand: "Suja",
      semanticProductFamily: "Juice & Wellness Shots",
      semanticVariant: "Digestion",
      semanticAliases: ["Suja Digestion", "wellness shot"],
      semanticConfidenceBps: 9500,
      semanticExactSkuKnown: true,
    }],
  });

  assert.equal(result.matches.every((match) => match.status !== "auto_matched"), true);
});

test("does not auto-match a bare brand across distinct Suja products", () => {
  const result = matchReceiptItemsToIntent({
    intentItems: [{ id: "suja-plan", label: "Suja", includedAtFreeze: true }],
    receiptItems: [
      { id: "digestion", rawDescription: "SUJADIGSTION", netAmountCents: 1269 },
      { id: "ginger", rawDescription: "SUJA GINGER SHOTS", netAmountCents: 1399 },
    ],
  });

  assert.equal(result.matches.every((match) => match.status !== "auto_matched"), true);
});

test("matches Hershey's Nuggets to the household's saved Chocolates item", () => {
  const result = matchReceiptItemsToIntent({
    intentItems: [
      { id: "chocolates-plan", label: "Chocolates", includedAtFreeze: true },
    ],
    receiptItems: [
      {
        id: "hersheys-nuggets-receipt",
        costcoItemNumber: "401621",
        rawDescription: "NUGGETS 52OZ",
        canonicalName: "Hershey's Nuggets",
        netAmountCents: 1799,
      },
    ],
  });

  assert.deepEqual(
    result.matches.map((match) => [
      match.intentItemId,
      match.receiptItemId,
      match.status,
      match.reason,
    ]),
    [[
      "chocolates-plan",
      "hersheys-nuggets-receipt",
      "auto_matched",
      "normalized_exact",
    ]],
  );
  assert.deepEqual(result.unmatchedReceiptItemIds, []);
});

test("a confirmed household alias matches future receipt wording without a catalog list item", () => {
  const result = matchReceiptItemsToIntent({
    intentItems: [{ id: "dal-plan", label: "Toor dal", includedAtFreeze: true }],
    receiptItems: [
      {
        id: "dal-receipt",
        productId: "product-dal",
        rawDescription: "PIGEON PEAS",
        netAmountCents: 1099,
      },
    ],
    aliases: [
      {
        normalizedDescription: "PIGEON PEAS",
        productId: "product-dal",
        confirmed: true,
      },
      {
        normalizedDescription: "TOOR DAL",
        productId: "product-dal",
        confirmed: true,
      },
    ],
  });

  assert.equal(result.matches.length, 1);
  assert.equal(result.matches[0].reason, "confirmed_alias");
  assert.equal(result.matches[0].status, "auto_matched");
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
