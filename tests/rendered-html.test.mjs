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

  for (const label of ["List", "Insights", "Products", "Recap"]) {
    assert.match(html, new RegExp(label));
  }

  assert.match(html, /Data status/i);
  assert.match(html, /href="\/signout-with-chatgpt\?return_to=%2F"[^>]*>Sign out<\/a>/i);
  assert.match(html, /Start shopping/i);
  assert.match(html, /Plan/);
  assert.match(html, /Shop/);
  assert.match(html, /One list, two phones/i);
});

test("renders accessible catalog and device theme controls", async () => {
  const response = await render();
  const html = await response.text();

  assert.match(html, /select[^>]+aria-label="Color theme"/i);
  assert.match(html, /<option value="system"[^>]*>Auto<\/option>/i);
  assert.match(html, /<option value="warm"[^>]*>Warm<\/option>/i);
  assert.match(html, /<option value="light"[^>]*>Light<\/option>/i);
  assert.match(html, /<option value="dark"[^>]*>Dark<\/option>/i);
  assert.match(html, /savedTheme === "warm"/i);
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
  assert.match(source, /No estimate · Add estimate/);
  assert.match(source, /household estimate/);
  assert.match(source, /parseManualEstimateDollars/);
  assert.match(source, /item\.includedAtFreeze !== true/);

  const reviewSource = await readFile(
    new URL("../app/receipt-review-flow.tsx", import.meta.url),
    "utf8",
  );
  assert.match(reviewSource, /Prices or quantities shifted/);
  assert.match(reviewSource, /receipt-spotlight/);
  assert.match(reviewSource, /showModal\(\)/);
  assert.match(reviewSource, /Tap to explore/);
  assert.match(reviewSource, /Open receipt items for \$\{driver\.label\}/);
  assert.match(reviewSource, /Each card shows the receipt item that received a Costco discount/);
  assert.match(reviewSource, /Saved \$\{money\.format/);
  assert.match(reviewSource, /Choose the receipt line that was this saved item/);
  assert.match(reviewSource, /Confirm match/);
  assert.match(reviewSource, /Review receipt lines/);
  assert.match(reviewSource, /onReviewReceipt=\{\(\) => onOpenReceipt\("check"\)\}/);
  assert.doesNotMatch(reviewSource, /Matched price or quantity change/);
});

test("keeps sandbox review answers in the owner-only test household", async () => {
  const dashboardSource = await readFile(
    new URL("../app/basket-sense-dashboard.tsx", import.meta.url),
    "utf8",
  );
  const reviewSource = await readFile(
    new URL("../app/receipt-review-flow.tsx", import.meta.url),
    "utf8",
  );

  assert.match(dashboardSource, /<ReviewTab[\s\S]*sandboxMode=\{sandboxMode\}/);
  assert.match(dashboardSource, /<ClosedLoopReview[\s\S]*sandboxMode=\{sandboxMode\}/);
  assert.match(reviewSource, /\.\.\.\(sandboxMode \? \{ sandbox: true \} : \{\}\)/);
});

test("uses a dense, top-down pop and flutter celebration", async () => {
  const dashboardSource = await readFile(
    new URL("../app/basket-sense-dashboard.tsx", import.meta.url),
    "utf8",
  );
  const styles = await readFile(
    new URL("../app/globals.css", import.meta.url),
    "utf8",
  );

  assert.match(dashboardSource, /Array\.from\(\{ length: 120 \}/);
  assert.match(dashboardSource, /shoppingCompleteConfettiStyle/);
  assert.match(styles, /\.shopping-complete-confetti \{[\s\S]*position: fixed;/);
  assert.match(styles, /left: var\(--confetti-start-x\);/);
  assert.match(styles, /top: -10dvh;/);
  assert.match(styles, /animation: shopping-confetti-shower var\(--confetti-duration\)/);
  assert.match(styles, /var\(--confetti-sway-a\)/);
  assert.match(styles, /var\(--confetti-sway-b\)/);
  assert.match(styles, /var\(--confetti-drift-x\)/);
  assert.match(styles, /var\(--confetti-fall\)/);
  assert.match(styles, /clip-path: polygon/);
  assert.match(styles, /@media \(prefers-reduced-motion: reduce\)[\s\S]*\.shopping-complete-confetti/);
  assert.match(styles, /:root\[data-theme="warm"\]/);
  assert.match(styles, /--card-shadow: 0 2px 6px/);
  assert.match(styles, /font-family: Georgia, "Times New Roman", serif;/);
  assert.match(
    styles,
    /\.week-page > \.page-heading\.with-controls::after[\s\S]*background-image: url\("\/basketsense-social-card\.png"\)/,
  );
  assert.match(
    styles,
    /\.week-summary > div:first-child[\s\S]*background: var\(--apricot-soft\)/,
  );
  assert.match(
    styles,
    /@media \(max-width: 760px\)[\s\S]*background-size: 620px auto;/,
  );
});

test("receipt capture offers camera, photo-library, and Costco PDF actions", async () => {
  const source = await readFile(
    new URL("../app/receipt-review-flow.tsx", import.meta.url),
    "utf8",
  );

  assert.match(source, /capture="environment"/);
  assert.match(source, /Take photo/);
  assert.match(source, /Choose photo or PDF/);
  assert.match(source, /accept="image\/\*,application\/pdf"/);
  assert.match(source, /Choose a Costco receipt photo or PDF from your library/);
  assert.match(source, /image\/heic/);
  assert.match(source, /Enter Discounts as a positive total/);
  assert.match(source, /<option value="discount">Discount<\/option>/);
});

test("keeps product-history additions and sorting in the shared list flow", async () => {
  const source = await readFile(
    new URL("../app/basket-sense-dashboard.tsx", import.meta.url),
    "utf8",
  );
  const styles = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");

  assert.match(source, /async function addCatalogProductToList/);
  assert.match(source, /action: "add_list_item"/);
  assert.match(source, /: "Add to list"/);
  assert.match(source, /className="product-row-open"/);
  assert.match(source, /className=\{`secondary-button product-row-action/);
  assert.match(source, /`Add \$\{rowProductName\} to list`/);
  assert.match(source, /void addProductFromRow\(rowCatalogProduct\)/);
  assert.match(source, /isOnList\s*\?\s*"On list"/);
  assert.match(source, /<option value="alphabetical">A–Z<\/option>/);
  assert.match(source, /productDisplayName\(left\)\.localeCompare/);
  assert.match(
    styles,
    /\.product-row \{[\s\S]*grid-template-columns: minmax\(0, 1fr\) auto;/,
  );
  assert.match(styles, /\.product-row-action \{[\s\S]*min-width: 64px;/);
  assert.match(
    styles,
    /@media \(max-width: 520px\)[\s\S]*\.product-row-open \.product-initial \{[\s\S]*display: none;/,
  );
});

test("chooses the latest completed trip for the recap", async () => {
  const source = await readFile(
    new URL("../app/api/household/route.ts", import.meta.url),
    "utf8",
  );

  assert.match(source, /INNER JOIN trips ON trips\.id = receipt_transactions\.trip_id/);
  assert.match(source, /trips\.status = 'completed'/);
  assert.match(source, /ORDER BY trips\.completed_at DESC/);
});
