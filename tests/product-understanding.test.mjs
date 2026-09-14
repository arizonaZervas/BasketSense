import assert from "node:assert/strict";
import test from "node:test";

import {
  buildProductUnderstandingRequest,
  parseProductUnderstandings,
  productUnderstandingLookupKey,
  understandReceiptProducts,
} from "../workers/receipt-ingestion/src/product-understanding.ts";
import { trustedDraftInterpretations } from "../app/api/household/route.ts";

test("product understanding uses stable item-number keys and excludes receipt accounting", () => {
  const line = { itemNumber: "1234567", rawDescription: "ZIPLC SLIDER" };
  assert.equal(productUnderstandingLookupKey(line), "item:1234567");

  const request = buildProductUnderstandingRequest([line]);
  const text = request.contents[0].parts[0].text;
  assert.match(text, /ZIPLC SLIDER/);
  assert.doesNotMatch(text, /lineSubtotalCents|netAmountCents|totalCents|taxCents/);
  assert.match(text, /do not decide whether an item was planned/i);
  assert.match(text, /searchAliases: alternative names for this exact product/i);
  assert.match(text, /intentAliases: broader shopping-list phrases/i);
});

test("product understanding accepts only requested lookup keys", () => {
  const parsed = parseProductUnderstandings({
    products: [
      {
        lookupKey: "item:1234567",
        canonicalName: "Ziploc Slider Storage Bags",
        brand: "Ziploc",
        productFamily: "Storage bags",
        variant: "Slider",
        categoryHint: "household_supplies",
        confidenceBps: 9300,
        exactSkuKnown: true,
        searchAliases: ["Ziploc bags", "slider bags"],
        intentAliases: ["food storage bags"],
      },
      {
        lookupKey: "item:not-requested",
        canonicalName: "Invented product",
        brand: null,
        productFamily: null,
        variant: null,
        categoryHint: null,
        confidenceBps: 10000,
        exactSkuKnown: true,
        searchAliases: [],
        intentAliases: [],
      },
    ],
  }, new Set(["item:1234567"]), "test-model");

  assert.equal(parsed.size, 1);
  assert.equal(parsed.get("item:1234567")?.canonicalName, "Ziploc Slider Storage Bags");
  assert.deepEqual(parsed.get("item:1234567")?.intentAliases, ["food storage bags"]);
  assert.equal(parsed.get("item:1234567")?.source, "gemini");
});

test("receipt persistence accepts only interpretation metadata already cached by the server", async () => {
  const cached = {
    lookup_key: "item:1234567",
    canonical_name: "Ziploc Slider Storage Bags",
    brand: "Ziploc",
    product_family: "Storage bags",
    variant: "Slider",
    category_hint: "household_supplies",
    confidence_bps: 9300,
    model: "test-model",
  };
  const db = {
    prepare() {
      return {
        bind() {
          return { all: async () => ({ results: [cached] }) };
        },
      };
    },
  };
  const base = {
    sourceLineNumber: 1,
    costcoItemNumber: "1234567",
    rawDescription: "ZIPLC SLIDER",
    interpretedName: cached.canonical_name,
    interpretedBrand: cached.brand,
    interpretedProductFamily: cached.product_family,
    interpretedVariant: cached.variant,
    interpretationCategoryHint: cached.category_hint,
    interpretationConfidenceBps: cached.confidence_bps,
    interpretationSource: "gemini",
    interpretationModel: cached.model,
    quantityMilli: 1000,
    unitPriceCents: null,
    lineSubtotalCents: 1499,
    discountCents: 0,
    netAmountCents: 1499,
    kind: "item",
    taxStatus: "unknown",
    isReturn: false,
  };

  const accepted = await trustedDraftInterpretations(db, "household", [base]);
  assert.equal(accepted[0].interpretedName, cached.canonical_name);

  const rejected = await trustedDraftInterpretations(db, "household", [{
    ...base,
    interpretedName: "Attacker supplied name",
  }]);
  assert.equal(rejected[0].interpretedName, null);
  assert.equal(rejected[0].interpretationSource, null);
});

test("fresh semantic understanding stays pending rather than changing the active catalog", async () => {
  let geminiCalls = 0;
  let persisted = 0;
  const db = {
    prepare(sql) {
      const statement = {
        sql,
        values: [],
        bind(...values) {
          this.values = values;
          return this;
        },
        async all() {
          if (/PRAGMA table_info/i.test(sql)) {
            return { results: [{ name: "intent_aliases_json" }] };
          }
          if (/FROM product_understandings/i.test(sql)) {
            assert.deepEqual(this.values.slice(1), [
              "costco-line-understanding-v2",
              "basketsense-product-understanding-v2",
            ]);
            return { results: [] };
          }
          if (/FROM products/i.test(sql)) {
            return {
              results: [{
                costco_item_number: "5161251",
                canonical_name: "UNSTPBL FRSH",
                brand: null,
                category: "household_supplies",
              }],
            };
          }
          return { results: [] };
        },
        async run() {
          return { success: true, meta: { changes: 1 } };
        },
      };
      return statement;
    },
    async batch(statements) {
      if (statements.some((statement) => /INSERT INTO product_understanding_candidates/i.test(statement.sql))) {
        persisted += 1;
      }
      return statements.map(() => ({ success: true, meta: { changes: 1 } }));
    },
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    geminiCalls += 1;
    return Response.json({
      candidates: [{
        content: {
          parts: [{
            text: JSON.stringify({
              products: [{
                lookupKey: "item:5161251",
                canonicalName: "Downy Unstopables Fresh In-Wash Scent Booster Beads",
                brand: "Downy",
                productFamily: "Laundry scent booster beads",
                variant: "Fresh",
                categoryHint: "household_supplies",
                confidenceBps: 9700,
                exactSkuKnown: true,
                searchAliases: ["Downy Fresh"],
                intentAliases: ["laundry scent booster"],
              }],
            }),
          }],
        },
      }],
    });
  };
  try {
    const result = await understandReceiptProducts({
      db,
      householdId: "household",
      apiKey: "test-key",
      model: "test-model",
      draft: {
        purchasedAt: "2026-08-29T12:00:00.000Z",
        subtotalCents: 1599,
        taxCents: 0,
        totalCents: 1599,
        discountCents: 0,
        lines: [{
          sourceLineNumber: 1,
          itemNumber: "5161251",
          rawDescription: "UNSTPBL FRSH",
          quantityMilli: 1000,
          unitPriceCents: 1599,
          lineSubtotalCents: 1599,
          discountCents: 0,
          netAmountCents: 1599,
          taxStatus: "unknown",
        }],
        warnings: [],
      },
    });
    assert.equal(geminiCalls, 1);
    assert.equal(persisted, 1);
    assert.equal(result.lines[0].understanding?.canonicalName, "UNSTPBL FRSH");
    assert.equal(result.lines[0].understanding?.source, "catalog");
    assert.deepEqual(result.lines[0].understanding?.searchAliases, []);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
