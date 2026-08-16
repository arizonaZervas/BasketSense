import assert from "node:assert/strict";
import test from "node:test";

import { confettiParticleCount } from "../app/confetti-canvas.tsx";

test("confetti stays dense while bounding phone and desktop particle work", () => {
  assert.equal(confettiParticleCount(390, 844), 220);
  assert.equal(confettiParticleCount(1_024, 768), 281);
  assert.equal(confettiParticleCount(1_920, 1_080), 420);
});
