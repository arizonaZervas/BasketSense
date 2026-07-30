# BasketSense receipt-ingestion staging Worker

This Worker is an isolated, staging-only processor. It is intentionally not
connected to the private family site yet.

It does two bounded jobs:

1. Read a private R2 receipt object referenced by `receipt_ingestions`, call
   Gemini `generateContent` with inline receipt data and JSON output, then
   validate the response against BasketSense's strict receipt contract, and
   write an advisory extraction draft back to private R2. It stops at
   `awaiting_review`; it never creates a
   transaction, product, alias, price, category, or household insight.
2. Render and send a trip summary only from a completed trip with a reconciled
   receipt. Each recipient gets one `email_outbox` row with a deterministic
   dedupe key. If delivery becomes uncertain, the row is marked `unknown` and
   is not automatically retried.

## Before any staging deployment

1. Apply `drizzle/0004_magical_patriot.sql` and
   `drizzle/0005_cheerful_the_professor.sql` to a **separate staging D1**.
2. Create a separate, private staging R2 receipt bucket. Do not bind the family
   bucket while this is being proven.
3. The staging D1 binding now points to
   `basketsense-receipt-ingestion-staging`. Replace only the placeholder staging
   R2 bucket name in `wrangler.jsonc` after R2 is enabled.
4. Onboard `goodcartday.com` for Cloudflare Email Sending before enabling the
   `EMAIL` binding. Until then, keep report triggering disabled.
5. Add staging-only secrets; never place them in `wrangler.jsonc` or `.env`
   committed files:

```bash
WRANGLER_LOG_PATH=.wrangler/wrangler.log npx wrangler secret put GEMINI_API_KEY --config workers/receipt-ingestion/wrangler.jsonc --env staging
WRANGLER_LOG_PATH=.wrangler/wrangler.log npx wrangler secret put INGESTION_INTERNAL_TOKEN --config workers/receipt-ingestion/wrangler.jsonc --env staging
```

The free Gemini API tier is a privacy choice, not merely a price choice. Verify
the current Google data-use terms before uploading real household receipts; use
the staging synthetic receipt only until the household explicitly accepts that
tradeoff.

Use a newly generated internal token. It protects the two internal routes; the
Worker exposes only `/health` without it.

## Staging smoke test

1. Insert one synthetic `receipt_ingestions` row whose source object is in the
   staging bucket and whose status is `uploaded`.
2. Call `POST /internal/ingestions/:id/run` with
   `x-basketsense-internal-token`.
3. Confirm the Workflow reaches `awaiting_review`, a private artifact appears
   below `receipt-ingestion-artifacts/<household>/<ingestion>/`, and no
   `receipt_transactions`, `receipt_items`, `products`, or `product_aliases`
   rows changed.
4. Complete a synthetic reconciled trip, then call
   `POST /internal/trips/:tripId/report`. Verify one outbox row per household
   member, and only test addresses receive mail.

## Deployment boundary

The existing BasketSense site must not call this Worker until all of the above
passes and the site receives an authenticated service binding. The eventual
integration should upload first, create a `receipt_ingestions` record, and
return `202`; it must never wait for OCR or Gemini in the mobile request.

Run these checks before staging deployment:

```bash
npx tsc --project workers/receipt-ingestion/tsconfig.json --noEmit
WRANGLER_LOG_PATH=.wrangler/wrangler.log npx wrangler types workers/receipt-ingestion/worker-configuration.d.ts --config workers/receipt-ingestion/wrangler.jsonc --env staging --check
WRANGLER_LOG_PATH=.wrangler/wrangler.log npx wrangler deploy --dry-run --config workers/receipt-ingestion/wrangler.jsonc --env staging
```

The Worker uses Cloudflare bindings for D1, R2, Workflows, and Email rather
than Cloudflare REST calls. Its Gemini prompt asks for strict, integer-cent
receipt evidence, but every result remains a reviewable draft because OCR and
vision can still be wrong.
