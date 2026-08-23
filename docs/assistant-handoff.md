# BasketSense assistant handoff

Use this file as the short, durable starting context for a new Codex chat after
older chats are archived. Read it with the root `README.md`, `PRODUCT.md`, and
the current Git status; verify any live deployment or Cloudflare fact before
changing it.

## Current product state

- BasketSense is a private, two-person Costco companion: shared list, frozen
  intent, private receipt review, explainable comparison, lightweight feedback,
  product history, and in-app recap.
- Receipt images and PDFs are private R2 objects. Household data is in the
  BasketSense D1 database. Do not expose, migrate, or reuse either outside this
  product.
- A receipt’s paid amount is its net amount after Costco discounts. UI that
  presents that number uses the label `Paid`.
- Generated product illustrations are the fallback visual treatment. Locally
  implemented standalone-receipt work can add a private AI-generated reference
  image in the background when a catalog product has no approved image. It is
  labeled as AI-generated, and a later household photo always replaces it as
  the primary image. External photo suggestions remain intentionally disabled.
- Matching starts with strong textual evidence. A household can confirm a
  receipt-line-to-list-item relationship once. Local Product Understanding and
  Intent Matching v1 now records that fulfillment independently of catalog
  identity, so a productless correction such as `Ziploc bags` to
  `ZIPLC SLIDER` can be reused on a later receipt. Gemini may separately propose
  a readable product name/family after strict extraction, but that metadata is
  advisory and cannot auto-confirm the household match.
- Receipt review preserves the frozen intent snapshot and projects included
  `added_after_freeze` list rows beside it at read time. Strong matches to those
  rows appear as `Added during trip + purchased`; only lines unmatched by both
  layers appear as `Not on saved list`.
- Completed trip intent and final-list evidence remain immutable. The owner can
  locally propose a replacement receipt for a completed trip; the old receipt
  stays authoritative until explicit confirmation, and every applied revision
  retains the previous totals, lines, matches, questions, and private file
  pointer for audit recovery.
- The customer-facing navigation has four destinations: List, Insights,
  Products, and Recap. Data Health is no longer a UI tab. Its owner-authorized
  backend inspection/export paths remain dormant for future debugging.

## Performance audit

- The 2026-08-08 code-confirmed performance audit and fresh-task trace plan are
  in `docs/performance-audit-handoff.md`.
- Chrome DevTools MCP was installed globally after that audit. It requires a
  fresh task/runtime before its tools are available.

## Owner test sandbox

- `/?sandbox=1` is an owner-only, isolated, disposable household for receipt
  and finalized-trip tests.
- It has no shared household history. Its review-question requests must carry
  `sandbox: true` so the API does not look in the shared household.
- A completed sandbox receipt can be reopened for another test cycle. This is
  intentionally unavailable in the real shared household.

## Local feature work awaiting release

- The complete 2026-08-15 deployment manifest, risk register, mobile evidence,
  monitoring plan, and rollback runbook are in
  `docs/release-readiness-2026-08-15.md`. The recommended first release is D1
  migrations 0009–0013 plus the private Sites app; the separate staging receipt
  Worker is explicitly excluded until its old email workflow/sender binding is
  removed and independently approved.

- Saturday Prep is implemented locally as an optional, List-native three-step
  review of likely-due and check-at-home suggestions. Only an explicit Add
  changes the shared list; Skip, Later, Have enough, and Not sure remain
  device-local planning choices.
- Household Product Memory is implemented locally with the explicit choices
  Buy again, Pause for now, and Not for us. Choices are append-only,
  receipt-backed feedback, editable from Products, and can also be captured in
  receipt review. The newest explicit choice wins; Pause and Not for us keep a
  product out of future Saturday Prep seeds.
- Ad hoc Costco purchases and returns are implemented locally as standalone
  private receipts with `trip_id = NULL`. Insights can upload and review
  Costco.com, tire, jewelry/precious-metal, or other purchases and returns
  outside the Saturday trip.
  The upload accepts PDF, JPEG, PNG, WebP, HEIC, and HEIF receipts.
  Drafts do not affect metrics. Explicit finalization adds a purchase or
  subtracts a signed return from net spending, while preserving categories,
  transactions, and receipt detail. Return lines link to catalog products but
  are excluded from purchase counts, price history, Product Memory, and
  recommendation learning. Both flows remain outside the Saturday trip loop
  and do not change trips, Lists, intent, comparisons, review questions,
  feedback, recaps, Product Memory, or Saturday suggestions.
- Explicit standalone finalization now promotes every unmatched purchase or
  return line into the household Products catalog, links the receipt line,
  records a receipt alias, and applies the existing rule-based category classifier.
  Discounts never create products. This catalog evidence does not make a
  Product Memory choice and does not add anything to the shared List.
- A finalized standalone receipt queues one durable image job for each linked
  product that lacks an approved primary image. Migration 0010 adds the D1
  `product_image_jobs` outbox. The existing scheduled receipt Worker processes
  at most two jobs per five-minute run, generates a generic 1:1 reference with
  `gemini-3.1-flash-image`, stores it privately in the existing BasketSense R2
  bucket, and retries transient failures up to three times. No new Cloudflare
  resource or binding is required.
- Migration 0009 makes only `receipt_ingestions.trip_id` nullable so the
  existing private upload/extraction path can attach directly to a standalone
  receipt. It has been generated and locally tested but not applied remotely.
- Migration 0010 creates only the product-image job table and its indexes. It
  has been generated and locally tested but not applied remotely.
- Historical Review and Receipt Capture Hardening v1 are implemented locally.
  Recap now loads a list of completed trips on demand and reads the selected
  trip's own frozen-list comparison. Both spouses can view history; only the
  owner can upload and confirm a historical replacement. Confirmation keeps
  the trip and receipt ID stable, rebuilds its comparison, promotes newly
  confirmed Products, queues missing product images, and does not resend a
  recap or change the frozen plan/final List. The correction dialog can either
  re-read the privately saved original or accept a replacement image/PDF. It
  shows current versus proposed totals, line counts, product-line changes, and
  the high-level estimate delta before the owner applies anything; the old
  receipt remains official throughout parsing and review.
- Image capture preserves an already-uploadable photo at its original
  resolution even when it is very tall. Larger photos are compressed by
  receipt width rather than height. Long images also produce a de-shadowed full
  view plus overlapping high-resolution vertical sections for a second reader
  pass. PDFs remain native. The reader first checks the original, automatically
  retries incomplete or failed reads with recovery evidence, accepts an exact
  totals-only result when product lines still fail, and stores only safe failure
  codes/provider IDs/timing—not receipt contents—in diagnostics.
- Migration 0011 adds private receipt-correction revision evidence and safe
  receipt-reader diagnostics. Migration 0012 makes explicit Product Memory
  durable by recording its product ID before historical line replacement; the
  migration backfills existing Product Memory from its receipt line.
- Migration 0013 adds an app-owned migration ledger. The private app now claims
  and applies 0009–0013 idempotently against its actual Sites `DB` binding before
  new receipt/history/Product Memory handlers continue. This is required because
  the Sites-managed D1 is not visible in the owner's Wrangler account and the
  available Sites database connector is read-only; never guess a remote D1 ID.
- Migration 0014 adds cached, household-scoped product understanding, nullable
  interpretation provenance on receipt lines, and product-ID-independent
  `intent_fulfillments`. The optional text-only Gemini stage runs only for
  uncached receipt labels, never receives receipt totals or List state, and is
  failure-tolerant. Full behavior and release gates are in
  `docs/product-understanding-and-intent-matching-v1.md`.
- The app accepts an optional `GEMINI_RECOVERY_MODEL` for pass 2; without it,
  pass 2 uses the primary configured model with the enhanced/section evidence.
  Verify and set a BasketSense recovery model during the release preflight if
  the owner wants the higher-quality-model fallback. Automatic post-finalization
  Workflow recovery remains intentionally deferred with the broader async
  ingestion architecture; totals-only spending can be finalized now and the
  saved original remains available for an explicit re-read/correction.
- None of this local feature work has been committed or deployed. Local release
  validation now has 128 BasketSense tests passing, a passing production build,
  zero lint errors, sequential migration rehearsal, and a real authenticated
  owner-sandbox walkthrough at 320×568, 390×844, 430×932, and 844×390. Before
  release, capture production invariants, retain Sites version 69, verify
  the existing Gemini secret without exposing it, and follow the canary in the
  release-readiness report.

## Recaps, e-mail, and the receipt Worker

- The supported recap path is inside the private app at `/recap`; automatic
  recap e-mail is disabled.
- Do not configure `EMAIL_FROM`, `allowed_sender_addresses`, or real sends
  unless a BasketSense-specific approved sender is verified and the owner
  authorizes it.
- `workers/receipt-ingestion/` contains BasketSense’s asynchronous extraction
  Worker. It is separate from the app source and must never be configured with
  Good Cart Day resources.

## Current site and access boundary

- The private site project is identified by `.openai/hosting.json`. Use Sites
  tooling to inspect its live URL, version, and access policy; do not create a
  replacement site, D1 database, or R2 bucket.
- Preserve the existing household access boundary and verify it live before
  modifying or deploying. As verified on 2026-08-15, the private Sites policy
  was custom revision 16 with exactly two account users and no external
  visitors. Do not print or copy account identifiers into repository docs.
- The latest verified production source commit is
  `067d4d44c585336ffbaa68c5220b56153c8032d5`, deployed as Sites version 69.
  Treat these values as a rollback checkpoint and re-verify them immediately
  before an authorized release.

## Hard scope boundaries

- `good-cart-day/` is a separate product. Never modify, stage, commit, deploy,
  or use its files/resources while working on BasketSense unless the owner
  explicitly changes scope.
- The `origin` GitHub remote is public. Do not push it unless the owner first
  approves the exact remote identity and privacy.
- Use the existing private Sites artifact repository only for approved
  BasketSense deployments.

## Useful verification

```bash
npm run build
node --import tsx --test tests/household-api.test.mjs tests/receipt-logic.test.mjs tests/dashboard-data.test.mjs tests/rendered-html.test.mjs
git status --short
```

For code discovery, prefer the `codebase-memory-mcp` graph. For a deploy,
confirm the existing private site and its allowlist, push the exact committed
source to its existing artifact repository, save that exact build as a version,
then poll the deployment to success.

## Keep this handoff current

Update this document after a material deployment, access-policy change,
integration decision, or durable product behavior change. Do not add secrets,
receipt data, access tokens, personal e-mail addresses, or private URLs.
