import assert from "node:assert/strict";
import test from "node:test";

import { resolveSpecificCatalogProduct } from "../app/product-intent-resolution.ts";

test("exact semantic product aliases resolve a typed household product name", () => {
  const result = resolveSpecificCatalogProduct("Downy Fresh", [{
    id: "downy",
    canonicalName: "Downy Unstopables Fresh In-Wash Scent Booster Beads",
    brand: "Downy",
    productFamily: "Laundry scent booster beads",
    variant: "Fresh",
    searchAliases: ["Downy Fresh", "Downy Unstopables Fresh"],
    confidenceBps: 9700,
  }]);
  assert.equal(result?.candidate.id, "downy");
  assert.equal(result?.reason, "alias_exact");
});

test("a generic family phrase does not permanently bind to one catalog SKU", () => {
  const result = resolveSpecificCatalogProduct("bread", [
    {
      id: "white-bread",
      canonicalName: "Naked White Bread",
      productFamily: "Bread",
      searchAliases: ["Naked white", "white sandwich bread"],
      confidenceBps: 9600,
    },
    {
      id: "wheat-bread",
      canonicalName: "Whole Wheat Sandwich Bread",
      productFamily: "Bread",
      searchAliases: ["whole wheat bread"],
      confidenceBps: 9600,
    },
  ]);
  assert.equal(result, null);
});

test("equally strong semantic aliases remain unresolved", () => {
  const result = resolveSpecificCatalogProduct("family snack", [
    {
      id: "snack-a",
      canonicalName: "Snack A",
      searchAliases: ["family snack"],
    },
    {
      id: "snack-b",
      canonicalName: "Snack B",
      searchAliases: ["family snack"],
    },
  ]);
  assert.equal(result, null);
});
