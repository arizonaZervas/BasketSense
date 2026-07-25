import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const publicRoot = fileURLToPath(new URL("../good-cart-day/", import.meta.url));
const familyMarkers = ["KS ORG 2% MK", "Navni", "AUDITED_RECEIPT_ITEMS_2026", "household_basketsense"];

async function files(root) {
  const entries = await readdir(root, { withFileTypes: true });
  return (await Promise.all(entries.map(async (entry) => entry.isDirectory() ? files(path.join(root, entry.name)) : [path.join(root, entry.name)]))).flat();
}

test("Good Cart Day source is isolated from the family application", async () => {
  const sourceFiles = (await files(publicRoot)).filter((file) => /\.(?:ts|tsx|css|md|json)$/.test(file) && !file.includes("/dist/"));
  const source = await Promise.all(sourceFiles.map((file) => readFile(file, "utf8")));
  const combined = source.join("\n");
  for (const marker of familyMarkers) assert.doesNotMatch(combined, new RegExp(marker, "i"));
  assert.doesNotMatch(combined, /\.\.\/app\/basketsense/i);
});

test("Good Cart Day public build contains no seeded family receipt markers", async () => {
  const bundleFiles = (await files(fileURLToPath(new URL("../good-cart-day/dist/", import.meta.url)))).filter((file) => /\.(?:js|html|json)$/.test(file));
  const bundle = (await Promise.all(bundleFiles.map((file) => readFile(file, "utf8")))).join("\n");
  for (const marker of familyMarkers) assert.doesNotMatch(bundle, new RegExp(marker, "i"));
});

test("public interest collection is consented and protected", async () => {
  const source = await readFile(new URL("../good-cart-day/app/api/beta-interest/route.ts", import.meta.url), "utf8");
  for (const required of ["TURNSTILE_SECRET_KEY", "BETA_INTEREST_HASH_PEPPER", "beta_interest_rate_limits", "genericSuccess", "consent", "temporarily unavailable"]) assert.match(source, new RegExp(required));
});

test("Good Cart Day only provides a neutral uninvited state", async () => {
  const source = await readFile(new URL("../good-cart-day/app/app/page.tsx", import.meta.url), "utf8");
  assert.match(source, /Access is invite-only/);
  assert.doesNotMatch(source, /create household/i);
});
