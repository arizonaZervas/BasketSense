import assert from "node:assert/strict";
import test from "node:test";
import { searchCatalog, catalogSearchScore, boundedSearchTerms, searchTermsFromJson } from "../app/catalog-search.ts";

const products = [
  { canonicalName: "KS BATH TISSUE", costcoItemNumber: "100", latestRawDescription: "KS BATH TISSUE", searchTerms: ["toilet paper", "bathroom tissue"] },
  { canonicalName: "BNTY ADV", costcoItemNumber: "200", latestRawDescription: "BNTY ADV", searchTerms: ["Bounty", "paper towels"] },
  { canonicalName: "KS TOWEL", costcoItemNumber: "300", latestRawDescription: "KS TOWEL", searchTerms: ["paper towels"] },
  { canonicalName: "MANDARINS", costcoItemNumber: "400", latestRawDescription: "MANDARINS", searchTerms: ["oranges"] },
];

test("shared catalog retrieval finds familiar names without changing SKU identity", () => {
  for (const [query, ids] of [["toilet paper", ["100"]], ["Bounty", ["200"]], ["paper towels", ["200", "300"]], ["oranges", ["400"]], ["200", ["200"]]]) {
    assert.deepEqual(searchCatalog(products, query).map((p) => p.costcoItemNumber), ids);
  }
  assert.deepEqual(searchCatalog(products, "toilet towels"), []);
  assert.equal(products[3].canonicalName, "MANDARINS");
});

test("every token must match; exact names outrank broad aliases with stable ties", () => {
  const exact = { ...products[1], canonicalName: "Bounty" };
  assert.equal(searchCatalog([products[1], exact], "Bounty")[0], exact);
  assert.deepEqual(searchCatalog(products, " BOUNTY—paper ").map((p) => p.costcoItemNumber), ["200"]);
  assert.deepEqual(searchCatalog(products, ""), products);
  assert.equal(catalogSearchScore({ ...products[1], searchTerms: undefined }, "Bounty"), null);
  assert.equal(searchCatalog(products, "bnty")[0], products[1]);
});

test("malformed knowledge cannot break search or create unbounded payloads", () => {
  for (const input of ["{", "null", "{}", "42"]) assert.deepEqual(searchTermsFromJson(input), []);
  assert.deepEqual(searchTermsFromJson('["Bounty",null,42,{},"Bounty",""]'), ["Bounty"]);
  assert.equal(boundedSearchTerms(Array.from({ length: 50 }, (_, n) => `${n}`)).length, 32);
  assert.equal(boundedSearchTerms(["x".repeat(1000)])[0].length, 100);
});
