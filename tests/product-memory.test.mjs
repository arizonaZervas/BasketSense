import assert from "node:assert/strict";
import test from "node:test";

import {
  isProductMemoryPreference,
  productMemoryLabel,
  productMemorySuppressesSuggestion,
} from "../app/product-memory.ts";

test("product memory accepts only the three explicit household choices", () => {
  assert.equal(isProductMemoryPreference("buy_again"), true);
  assert.equal(isProductMemoryPreference("pause"), true);
  assert.equal(isProductMemoryPreference("not_for_us"), true);
  assert.equal(isProductMemoryPreference("worthwhile_discovery"), false);
  assert.equal(isProductMemoryPreference(null), false);
});

test("paused and not-for-us products stay out of future suggestions", () => {
  assert.equal(productMemorySuppressesSuggestion("buy_again"), false);
  assert.equal(productMemorySuppressesSuggestion("pause"), true);
  assert.equal(productMemorySuppressesSuggestion("not_for_us"), true);
  assert.equal(productMemorySuppressesSuggestion(null), false);
  assert.equal(productMemoryLabel("buy_again"), "Buy again");
});
