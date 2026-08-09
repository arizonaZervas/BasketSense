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
  assert.match(
    html,
    /38(?:<!-- -->)? receipt transactions audited · (?:<!-- -->)?Jan 2–Jul 18, 2026/,
  );
  assert.match(html, /both spouses edit one list/i);
  assert.match(html, /Estimated list total/i);
  assert.match(html, /Updates with the live list/i);
  assert.match(html, /before tax/i);
  assert.match(html, /Suggested starting points for (?:<!-- -->)?Jul 25/i);
  assert.match(html, /Active List/i);
  assert.match(html, />Ideas</i);
  assert.match(html, /Kirkland Signature organic 2% milk/i);
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
  assert.match(source, /data-list-focus-action="remove"/);
  assert.match(source, /data-list-focus-action="add"/);
  assert.match(source, /fallbackItemId/);
  assert.match(source, /focus\(\{ preventScroll: true \}\)/);
  assert.match(source, /No estimate · Add estimate/);
  assert.match(source, /household estimate/);
  assert.match(source, /parseManualEstimateDollars/);
  assert.match(source, /item\.includedAtFreeze !== true/);

  const reviewSource = await readFile(
    new URL("../app/receipt-review-flow.tsx", import.meta.url),
    "utf8",
  );
  assert.match(reviewSource, /Receipt matched/);
  assert.match(reviewSource, /receipt-spotlight/);
  assert.match(reviewSource, /showModal\(\)/);
  assert.match(reviewSource, /Tap to explore/);
  assert.match(reviewSource, /Each card shows the receipt item that received a Costco discount/);
  assert.match(reviewSource, /Choose the receipt line that was this saved item/);
  assert.match(reviewSource, /Confirm match/);
  assert.match(reviewSource, /Review receipt lines/);
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

test("uses a smooth, top-down celebration without converging particle paths", async () => {
  const dashboardSource = await readFile(
    new URL("../app/basket-sense-dashboard.tsx", import.meta.url),
    "utf8",
  );
  const confettiSource = await readFile(
    new URL("../app/top-down-confetti.ts", import.meta.url),
    "utf8",
  );
  const styles = await readFile(
    new URL("../app/globals.css", import.meta.url),
    "utf8",
  );

  assert.match(dashboardSource, /Array\.from\(\{ length: 120 \}/);
  assert.match(dashboardSource, /topDownConfettiStyle/);
  assert.match(dashboardSource, /const completesList =[\s\S]*activeIncluded\.length === 1/);
  assert.match(dashboardSource, /onToggleChecked\(item\)\.then\(\(saved\) =>/);
  assert.match(confettiSource, /--confetti-drift-mid/);
  assert.match(confettiSource, /--confetti-drift-late/);
  assert.match(styles, /\.shopping-complete-confetti \{[\s\S]*position: fixed;/);
  assert.match(styles, /left: var\(--confetti-start-x\);/);
  assert.match(styles, /top: -10dvh;/);
  assert.match(styles, /animation: shopping-confetti-shower var\(--confetti-duration\)/);
  assert.match(styles, /var\(--confetti-drift-mid\)/);
  assert.match(styles, /var\(--confetti-drift-late\)/);
  assert.match(styles, /var\(--confetti-drift-x\)/);
  assert.match(styles, /var\(--confetti-fall\)/);
  assert.doesNotMatch(styles, /--confetti-sway-a|--confetti-sway-b/);
  assert.match(styles, /clip-path: polygon/);
  assert.match(styles, /@media \(prefers-reduced-motion: reduce\)[\s\S]*\.shopping-complete-confetti/);
  assert.match(styles, /:root\[data-theme="warm"\]/);
  assert.match(styles, /--card-shadow: 0 2px 6px/);
  assert.match(styles, /font-family: Georgia, "Times New Roman", serif;/);
  assert.match(
    styles,
    /\.week-page > \.page-heading\.with-controls::after[\s\S]*background-image: url\("\/basketsense-hero-art\.png"\)/,
  );
  assert.match(
    styles,
    /\.week-summary > div:first-child[\s\S]*background: var\(--apricot-soft\)/,
  );
  assert.match(
    styles,
    /@media \(max-width: 1050px\)[\s\S]*background-size: 1150px auto;/,
  );
});

test("keeps the insights review form safe for receipt-only products", async () => {
  const dashboardSource = await readFile(
    new URL("../app/basket-sense-dashboard.tsx", import.meta.url),
    "utf8",
  );

  assert.match(dashboardSource, /catalogProduct\?\.categoryReviewedByDisplayName/);
  assert.match(dashboardSource, /reviewRequestedReceiptItemId[\s\S]*onConfirmReceiptProduct/);
});

test("re-encodes large camera photos below the live multipart safety budget", async () => {
  const receiptFlowSource = await readFile(
    new URL("../app/receipt-review-flow.tsx", import.meta.url),
    "utf8",
  );

  assert.match(receiptFlowSource, /Math\.floor\(1\.5 \* 1024 \* 1024\)/);
  assert.match(receiptFlowSource, /await encode\(1_600, 0\.7\)/);
  assert.match(receiptFlowSource, /await encode\(1_280, 0\.66\)/);
  assert.match(receiptFlowSource, /compressed\.size > LIVE_UPLOAD_SAFE_BYTES\) return file/);
});

test("reflows every primary surface from the available content width", async () => {
  const styles = await readFile(
    new URL("../app/globals.css", import.meta.url),
    "utf8",
  );

  assert.match(styles, /\.main-canvas \{[\s\S]*container-name: basket-main;[\s\S]*container-type: inline-size;/);
  assert.match(
    styles,
    /@container basket-main \(max-width: 1180px\) \{[\s\S]*\.dashboard-grid,[\s\S]*grid-template-columns: 1fr;/,
  );
  assert.match(
    styles,
    /@container basket-main \(max-width: 860px\) \{[\s\S]*\.metrics-strip\.four[\s\S]*repeat\(2, minmax\(0, 1fr\)\)/,
  );
  assert.match(
    styles,
    /@container basket-main \(max-width: 680px\) \{[\s\S]*\.data-explorer-controls,[\s\S]*\.question-options[\s\S]*grid-template-columns: 1fr;/,
  );
});

test("preserves an optimistic check while a stale list refresh is in flight", async () => {
  const dashboardSource = await readFile(
    new URL("../app/basket-sense-dashboard.tsx", import.meta.url),
    "utf8",
  );

  assert.match(dashboardSource, /pendingCheckedStates/);
  assert.match(dashboardSource, /function keepPendingCheckedStates/);
  assert.match(dashboardSource, /listItems: keepPendingCheckedStates\(snapshot\.listItems\)/);
  assert.match(dashboardSource, /pendingCheckedStates\.current\.set\(item\.id, nextChecked\)/);
  assert.match(dashboardSource, /onFailure: \(\) => \{\s*pendingCheckedStates\.current\.delete\(item\.id\)/);
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
    /\.product-row \{[\s\S]*grid-template-columns: auto minmax\(0, 1fr\) auto;/,
  );
  assert.match(styles, /\.product-row-action \{[\s\S]*min-width: 64px;/);
  assert.match(source, /className="product-row-image-button"/);
  assert.match(source, /Open full image for \$\{rowProductName\}/);
  assert.match(source, /function ProductImagePreviewDialog/);
  assert.match(source, /event\.key === "Escape"/);
  assert.match(styles, /\.product-image-preview-backdrop \{[\s\S]*backdrop-filter: blur\(10px\);/);
  assert.match(styles, /\.product-image-preview \{[\s\S]*transform: scale\(0\.97\);/);
});

test("makes unresolved category rows directly reviewable", async () => {
  const source = await readFile(
    new URL("../app/basket-sense-dashboard.tsx", import.meta.url),
    "utf8",
  );

  assert.match(source, /Review & categorize products/);
  assert.match(source, /Review & categorize →/);
  assert.match(source, /function openProductReview\(productId: string, receiptItemId: string\)/);
  assert.match(source, /onReviewProduct=\{openProductReview\}/);
  assert.match(source, /reviewRequestedForProductId/);
  assert.match(source, /reviewRequestedReceiptItemId/);
  assert.match(source, /action: "confirm_receipt_product"/);
  assert.match(source, /openProductReviewForm\(\);/);
  assert.match(source, /Receipt discount · already applied/);
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
