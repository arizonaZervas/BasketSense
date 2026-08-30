import assert from "node:assert/strict";
import test from "node:test";

import {
  backtestRecommendationCatalog,
  evaluateRecommendationCatalog,
} from "../app/recommendation-engine-v2.ts";
import { matchReceiptItemsToIntent } from "../app/receipt-logic.ts";

test("receipt-style abbreviations match a deliberately inexact household list", () => {
  const result = matchReceiptItemsToIntent({
    intentItems: [
      { id: "milk", label: "Organic 2% milk" },
      { id: "water", label: "Coconut water" },
      { id: "bags", label: "Ziploc bags" },
      { id: "dessert", label: "Cupcakes" },
    ],
    receiptItems: [
      { id: "milk-line", rawDescription: "KS ORG 2% MK" },
      { id: "water-line", rawDescription: "COCONUT WATR" },
      { id: "bags-line", rawDescription: "ZIPLC SLIDER" },
      { id: "dessert-line", rawDescription: "CUP CAKES" },
    ],
  });

  assert.deepEqual(
    result.matches.map((match) => [match.intentItemId, match.receiptItemId]),
    [
      ["bags", "bags-line"],
      ["dessert", "dessert-line"],
      ["water", "water-line"],
      ["milk", "milk-line"],
    ],
  );
  assert.ok(result.matches.every((match) => match.status === "auto_matched"));
});

const catalog = [
  {
    productId: "milk",
    itemNumber: "100",
    name: "Organic milk",
    category: "groceries_beverages",
    state: "essential",
    purchases: [
      { purchasedOn: "2026-06-06", quantityMilli: 1000, unitPriceCents: 1399 },
      { purchasedOn: "2026-06-20", quantityMilli: 1000, unitPriceCents: 1399 },
      { purchasedOn: "2026-07-04", quantityMilli: 1000, unitPriceCents: 1449 },
      { purchasedOn: "2026-07-18", quantityMilli: 1000, unitPriceCents: 1449 },
    ],
  },
  {
    productId: "bags",
    itemNumber: "200",
    name: "Food storage bags",
    category: "household_essentials",
    purchases: [
      { purchasedOn: "2026-01-10", quantityMilli: 1000, unitPriceCents: 1499 },
      { purchasedOn: "2026-05-16", quantityMilli: 1000, unitPriceCents: 1599 },
    ],
  },
  {
    productId: "gold",
    itemNumber: "300",
    name: "Gold bar",
    category: "other",
    state: "one_off",
    purchases: [
      { purchasedOn: "2026-04-01", quantityMilli: 1000, unitPriceCents: 200000 },
      { purchasedOn: "2026-04-02", quantityMilli: 1000, unitPriceCents: 200000 },
    ],
  },
  {
    productId: "never-bought",
    itemNumber: null,
    name: "Catalog-only product",
    category: null,
    purchases: [],
  },
];

test("recommendation v2 evaluates the entire catalog and never promotes one-off products", () => {
  const run = evaluateRecommendationCatalog({ products: catalog, asOfDate: "2026-07-18" });

  assert.equal(run.catalogSize, catalog.length);
  assert.equal(run.assessments.length, catalog.length);
  assert.equal(run.assessments.find((item) => item.productId === "gold").eligible, false);
  assert.equal(run.assessments.find((item) => item.productId === "never-bought").eligible, false);
  assert.equal(run.recommendations[0].productId, "milk");
  assert.ok(run.recommendations[0].components.every(
    (entry) => entry.points >= 0 && entry.points <= entry.maximum,
  ));
});

test("recommendation v2 backtests are cutoff-safe and report bounded metrics", () => {
  const beforeFuturePurchase = evaluateRecommendationCatalog({
    products: catalog,
    asOfDate: "2026-07-18",
  });
  const withUnreachableFuture = evaluateRecommendationCatalog({
    products: catalog.map((product) => product.productId === "milk"
      ? {
          ...product,
          purchases: [...product.purchases, {
            purchasedOn: "2027-01-01",
            quantityMilli: 50_000,
            unitPriceCents: 1,
          }],
        }
      : product),
    asOfDate: "2026-07-18",
  });
  assert.deepEqual(withUnreachableFuture, beforeFuturePurchase);

  const backtest = backtestRecommendationCatalog({
    products: catalog,
    targetDates: ["2026-06-20", "2026-07-04", "2026-07-18"],
    k: 3,
  });
  assert.equal(backtest.points.length, 3);
  assert.ok(backtest.precisionAtK >= 0 && backtest.precisionAtK <= 1);
  assert.equal(backtest.catalogCoverage, 0.75);
  assert.ok(backtest.falsePositiveBurden >= 0);
});

test("recommendation v2 learns only from completed earlier recommendation cycles", () => {
  const baseProduct = catalog.find((product) => product.productId === "bags");
  const baseline = evaluateRecommendationCatalog({
    products: [baseProduct],
    asOfDate: "2026-07-18",
  });
  const currentCycleResponse = evaluateRecommendationCatalog({
    products: [{
      ...baseProduct,
      outcomes: [{
        recordedAt: "2026-07-10T12:00:00.000Z",
        cycleDate: "2026-07-18",
        value: "removed",
      }],
    }],
    asOfDate: "2026-07-18",
  });
  assert.deepEqual(currentCycleResponse, baseline);

  const priorCycleResponse = evaluateRecommendationCatalog({
    products: [{
      ...baseProduct,
      outcomes: [{
        recordedAt: "2026-07-10T12:00:00.000Z",
        cycleDate: "2026-07-11",
        value: "removed",
      }],
    }],
    asOfDate: "2026-07-18",
  });
  assert.equal(
    priorCycleResponse.assessments[0].scoreBps,
    baseline.assessments[0].scoreBps - 300,
  );
});
