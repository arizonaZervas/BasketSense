import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";

import { productIllustrationManifest } from "../app/product-illustration-manifest";

const manifest = productIllustrationManifest();
const accepted = manifest.filter((entry) => entry.acceptanceStatus === "accepted");
const pending = manifest.filter((entry) => entry.acceptanceStatus === "pending");
const excluded = manifest.filter((entry) => entry.acceptanceStatus === "excluded");
const missingAssets = accepted.filter((entry) => {
  if (!entry.generatedAssetPath) return true;
  return !existsSync(resolve(process.cwd(), "public", entry.generatedAssetPath.slice(1)));
});
const emptyAssets = accepted.filter((entry) => {
  if (!entry.generatedAssetPath) return false;
  const assetPath = resolve(process.cwd(), "public", entry.generatedAssetPath.slice(1));
  return existsSync(assetPath) && statSync(assetPath).size === 0;
});

if (manifest.length !== 272) {
  throw new Error(`Expected the 272-item Products-tab worklist, found ${manifest.length}.`);
}
if (excluded.length !== 1 || excluded[0]?.itemNumber !== "0000") {
  throw new Error("The Discounts adjustment must be the only excluded worklist entry.");
}
if (missingAssets.length || emptyAssets.length) {
  throw new Error(
    `Illustration asset integrity failed: ${[...missingAssets, ...emptyAssets]
      .map((entry) => entry.itemNumber)
      .join(", ")}`,
  );
}

console.log(
  JSON.stringify(
    {
      total: manifest.length,
      accepted: accepted.length,
      pending: pending.length,
      excluded: excluded.length,
      promptVersion: manifest[0]?.promptVersion,
    },
    null,
    2,
  ),
);
