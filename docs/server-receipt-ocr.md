# Server receipt OCR

BasketSense has a server-side receipt reader at `POST /api/receipt-ocr`.
It accepts an authenticated receipt photo or Costco PDF, sends it directly to
Cloudflare Workers AI Markdown Conversion, and returns a deterministic Costco
receipt draft. The original is **not stored** by this step. It is stored
privately in R2 only after the household confirms the structured receipt.

## What it does

1. Validates a PDF, JPEG, PNG, or WebP receipt file (maximum 12 MB).
2. Uses Cloudflare Workers AI Markdown Conversion with plain-text output.
3. Parses totals, discounts, quantities, item numbers, and product lines with
   `parseCostcoOcrText`.
4. Sends the draft to the existing confirmation flow, which reconciles totals,
   compares frozen intent with actual receipt lines, and asks focused questions.

OCR only supplies evidence. It never automatically creates a household product,
alias, category, recommendation, or accounting decision. An unknown line still
uses the existing **Teach BasketSense** confirmation flow.

## Deployment prerequisite

The preferred configuration is an AI binding named `AI` on the deployed
Cloudflare Worker. Cloudflare documents the binding as `env.AI`; its
`toMarkdown()` API accepts a file Blob and can return plain text.

The current Sites deployment does not expose an AI binding configuration
surface, so it uses the equivalent Workers AI REST endpoint only when these
hosted runtime values exist:

- `CLOUDFLARE_ACCOUNT_ID`
- `CLOUDFLARE_WORKERS_AI_TOKEN` (a hosted secret with the Workers AI permission,
  scoped to the BasketSense Cloudflare account)

The route prefers `env.AI` when a binding later becomes available. The REST
token must never be checked into source, returned to the browser, or logged.
Without either server-side option, the route intentionally returns a friendly
`503` and the app keeps the manual totals path available.

## Verification after deployment

Use one clear, non-sensitive test receipt and verify:

1. A saved photo or Costco PDF becomes a server-generated draft without browser
   Tesseract loading.
2. The draft subtotal, tax, and total reconcile against the receipt.
3. Known aliases match frozen list items; unknown lines remain reviewable.
4. No new catalog product appears until a household member explicitly confirms it.
5. The original photo or PDF is private in R2 only after confirmation.
