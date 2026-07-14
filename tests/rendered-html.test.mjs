import assert from "node:assert/strict";
import test from "node:test";

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request("http://localhost/", {
      headers: { accept: "text/html" },
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
  assert.match(html, /Patterns worth seeing/);
  assert.match(html, /Sample household/);
  assert.doesNotMatch(html, /codex-preview|react-loading-skeleton|Your site is taking shape/i);
});

test("renders the five approved product surfaces", async () => {
  const response = await render();
  const html = await response.text();

  for (const label of ["Overview", "Spending", "Products", "This Week", "Review"]) {
    assert.match(html, new RegExp(label));
  }

  assert.match(html, /Added receipt history|Add receipts/i);
  assert.match(html, /System suggestion/);
  assert.match(html, /Receipt facts first|Costco this year/);
});
