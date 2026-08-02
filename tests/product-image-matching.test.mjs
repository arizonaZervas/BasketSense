import assert from "node:assert/strict";
import test from "node:test";

import {
  isTrustedOpenFoodFactsImageUrl,
  licensedOpenFoodFactsCandidates,
  scoreOpenFoodFactsProduct,
} from "../app/product-image-matching.ts";

test("scores a close brand and product-name match above a generic result", () => {
  const close = scoreOpenFoodFactsProduct({
    canonicalName: "Kirkland Organic 2% Milk",
    brand: "Kirkland Signature",
    candidate: {
      product_name: "Organic reduced fat 2% milk",
      brands: "Kirkland Signature",
    },
  });
  const generic = scoreOpenFoodFactsProduct({
    canonicalName: "Kirkland Organic 2% Milk",
    brand: "Kirkland Signature",
    candidate: { product_name: "Whole milk", brands: "Another dairy" },
  });

  assert.ok(close >= 6_000);
  assert.ok(close > generic);
});

test("keeps only useful image candidates from trusted Open Food Facts hosts", () => {
  const candidates = licensedOpenFoodFactsCandidates({
    canonicalName: "Organic 2% Milk",
    brand: "Kirkland Signature",
    products: [
      {
        code: "123",
        product_name: "Organic 2% Milk",
        brands: "Kirkland Signature",
        quantity: "3 x 64 fl oz",
        image_front_url: "https://images.openfoodfacts.org/images/products/123/front_en.400.jpg",
        image_front_width: 400,
        image_front_height: 400,
      },
      {
        code: "456",
        product_name: "Organic 2% Milk",
        brands: "Kirkland Signature",
        image_front_url: "https://example.com/copied-image.jpg",
      },
    ],
  });

  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].externalId, "123");
  assert.equal(candidates[0].widthPx, 400);
  assert.equal(
    isTrustedOpenFoodFactsImageUrl(
      "https://images.openfoodfacts.org/images/products/123/front_en.400.jpg",
    ),
    true,
  );
  assert.equal(isTrustedOpenFoodFactsImageUrl("https://example.com/image.jpg"), false);
});

test("accepts Search-a-licious brand arrays", () => {
  const candidates = licensedOpenFoodFactsCandidates({
    canonicalName: "Organic Whole Milk",
    brand: "Kirkland",
    products: [
      {
        code: "0196633946935",
        product_name: "Organic whole milk kirkland",
        brands: ["Kirkland", "Kirkland Signature"],
        image_front_url:
          "https://images.openfoodfacts.org/images/products/019/663/394/6935/front_en.6.400.jpg",
      },
    ],
  });

  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].brand, "Kirkland, Kirkland Signature");
});
