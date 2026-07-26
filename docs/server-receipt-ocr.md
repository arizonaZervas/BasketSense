# Server receipt OCR

BasketSense now has a server-side receipt reader at `POST /api/receipt-ocr`.
It accepts an authenticated receipt photo, sends it directly to the configured
Cloudflare Workers AI binding, and returns a deterministic Costco receipt draft.
The photo is **not stored** by this step. It is stored privately in R2 only
after the household confirms the structured receipt.

## What it does

1. Validates a JPEG, PNG, or WebP receipt photo (maximum 12 MB).
2. Uses Cloudflare Workers AI Markdown Conversion with plain-text output.
3. Parses totals, discounts, quantities, item numbers, and product lines with
   `parseCostcoOcrText`.
4. Sends the draft to the existing confirmation flow, which reconciles totals,
   compares frozen intent with actual receipt lines, and asks focused questions.

OCR only supplies evidence. It never automatically creates a household product,
alias, category, recommendation, or accounting decision. An unknown line still
uses the existing **Teach BasketSense** confirmation flow.

## Deployment prerequisite

Configure an AI binding named `AI` on the deployed Cloudflare Worker. Cloudflare
documents the binding as `env.AI`; its `toMarkdown()` API accepts a file Blob and
can return plain text. No API token or client-side secret is needed for this
binding approach.

Until that binding exists, the route intentionally returns a friendly `503` and
the app keeps the manual totals path available. Do not expose a Workers AI token
to the browser as a workaround.

## Verification after deployment

Use one clear, non-sensitive test receipt and verify:

1. The photo becomes a server-generated draft without browser Tesseract loading.
2. The draft subtotal, tax, and total reconcile against the receipt.
3. Known aliases match frozen list items; unknown lines remain reviewable.
4. No new catalog product appears until a household member explicitly confirms it.
5. The original is private in R2 only after confirmation.
