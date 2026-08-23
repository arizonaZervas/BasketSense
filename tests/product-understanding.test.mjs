import assert from "node:assert/strict";
import test from "node:test";

import {
  buildProductUnderstandingRequest,
  parseProductUnderstandings,
  productUnderstandingLookupKey,
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
      },
    ],
  }, new Set(["item:1234567"]), "test-model");

  assert.equal(parsed.size, 1);
  assert.equal(parsed.get("item:1234567")?.canonicalName, "Ziploc Slider Storage Bags");
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
