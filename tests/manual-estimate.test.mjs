import assert from "node:assert/strict";
import test from "node:test";

import {
  manualEstimateDraft,
  parseManualEstimateDollars,
} from "../app/manual-estimate.ts";

test("parses a sensible whole-package dollar estimate into cents", () => {
  assert.deepEqual(parseManualEstimateDollars("24"), {
    cents: 2400,
    error: null,
  });
  assert.deepEqual(parseManualEstimateDollars("$27.50"), {
    cents: 2750,
    error: null,
  });
  assert.equal(manualEstimateDraft(2400), "24");
  assert.equal(manualEstimateDraft(2750), "27.50");
});

test("rejects empty, non-positive, over-precise, and implausibly large estimates", () => {
  for (const value of ["", "0", "-3", "12.345", "100000.01", "rice"]) {
    const parsed = parseManualEstimateDollars(value);
    assert.equal(parsed.cents, null, `${value} should not be accepted`);
    assert.ok(parsed.error);
  }
});
