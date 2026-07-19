import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request("http://localhost/", {
      headers: {
        accept: "text/html",
        "oai-authenticated-user-email": "primary@example.test",
        "oai-authenticated-user-full-name": "Primary%20Member",
        "oai-authenticated-user-full-name-encoding": "percent-encoded-utf-8",
      },
    }),
    {
      ASSETS: {
        fetch: async () => new Response("Not found", { status: 404 }),
      },
    },
    {
      waitUntil() {},
      passThroughOnException() {},
    },
  );
}

test("server-renders the BasketSense dashboard", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<title>BasketSense — Our Costco companion<\/title>/i);
  assert.match(html, /Our Costco companion/);
  assert.match(html, /This Saturday/);
  assert.match(html, /Receipts suggest timing\. You decide need\./);
  assert.match(
    html,
    /38(?:<!-- -->)? receipt transactions audited · (?:<!-- -->)?Jan 2–Jul 18, 2026/,
  );
  assert.match(html, /both spouses edit one list/i);
  assert.match(html, /Estimated list total/i);
  assert.match(html, /Updates with the live list/i);
  assert.match(html, /before tax/i);
  assert.match(html, /The database is the shared source of truth/i);
  assert.match(html, /Suggested starting points for (?:<!-- -->)?Jul 25/i);
  assert.match(html, /Active List/i);
  assert.match(html, />Ideas</i);
  assert.match(html, /every five seconds while visible/i);
  assert.match(html, /Kirkland Signature organic 2% milk/i);
  assert.match(html, /26 purchases \(28 units\).*median interval 7 days/i);
  assert.match(html, /Optional seasonal favorite/i);
  assert.match(html, /Lychee/i);
  assert.doesNotMatch(html, /automatically versioned|Saved just now|share this link/i);
  assert.doesNotMatch(
    html,
    /Sample data|Sample household|Saved on this device|Edits do not sync|Suggested from 24 purchases|2025/i,
  );
  assert.doesNotMatch(html, /codex-preview|react-loading-skeleton|Your site is taking shape/i);
});

test("renders the four focused household destinations", async () => {
  const response = await render();
  const html = await response.text();

  for (const label of ["List", "Insights", "Products", "Review"]) {
    assert.match(html, new RegExp(label));
  }

  assert.match(html, /Data status/i);
  assert.match(html, /Start shopping/i);
  assert.match(html, /Plan/);
  assert.match(html, /Shop/);
  assert.match(html, /One list, two phones/i);
});

test("renders accessible catalog and device theme controls", async () => {
  const response = await render();
  const html = await response.text();

  assert.match(html, /role="group" aria-label="Color theme"/i);
  assert.match(html, /aria-label="Switch to dark theme"/i);
  assert.match(html, />Auto</i);
  assert.match(html, /role="combobox"/i);
  assert.match(html, /aria-autocomplete="list"/i);
  assert.match(html, /aria-controls="household-product-catalog"/i);
  assert.match(html, /Search all past warehouse products or add a new item/i);
  assert.doesNotMatch(html, /<datalist/i);
});

test("keeps shopping undo and catalog keyboard focus behavior wired", async () => {
  const source = await readFile(
    new URL("../app/basket-sense-dashboard.tsx", import.meta.url),
    "utf8",
  );

  assert.match(source, /action: "unfreeze_trip"/);
  assert.match(source, /Back to planning/);
  assert.match(source, /frozenContextKey/);
  assert.match(source, /startShoppingRef\.current\?\.focus\(\)/);
  assert.match(source, /unfreezeTriggerRef\.current\?\.focus\(\)/);
  assert.match(source, /scrollIntoView\(\{ block: "nearest" \}\)/);
  assert.match(source, /onPointerDown=\{\(event\) => event\.preventDefault\(\)\}/);
});
