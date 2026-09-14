# BasketSense assistant handoff

Use this file as the short, durable starting context for a new Codex chat after
older chats are archived. Read it with the root `README.md`, `PRODUCT.md`, and
the current Git status; verify any live deployment or Cloudflare fact before
changing it.

## Current product state

- 2026-09-13 runtime knowledge safety integration implemented locally, NOT released:
  new Gemini interpretations go to a separate pending-candidate table; confirmed
  household products exclude model profiles in search, typed-item resolution,
  receipt metadata validation/matching and Worker reads. Old unconfirmed profiles
  remain usable. No candidate promotion UI or recommendation scoring change yet.
  Additive migration `0018_knowledge_candidates.sql` generated, not applied live.
  233 tests, scoped lint, Worker typecheck and production build pass; local owner
  sandbox API integration uses mocked Gemini, not a live browser test. See
  `docs/backlog/catalog-knowledge-backfill.md` for tradeoffs and rollback. No new
  provider calls, production data changes, commit or deployment in this slice.

- 2026-09-13 Product Intelligence PI-2 checkpoint: local coverage/backfill CLI
  implemented, review-only and dry-run by default. Read-only live DB inspection
  found 312 active primary-household products: 20 ready current profiles, 1
  uncertain, 291 missing/current version absent (4 stale). Owner sandbox is
  separate. Owner-approved 12-product Gemini pilot completed: one call,
  $0.0047646 paid-rate equivalent (owner showed no billing; not a charge),
  4.658 seconds. Desired retrieval checks rose 11/14 to 13/14, but
  exclusions fell 6/6 to 4/6. Wrong high-confidence bread/juice and chocolate/chicken
  identities prohibit activation; all proposals remain local. Evidence precedence
  and conflict quarantine now implemented in review-only tooling (v2). Live audit
  found missing confirmed bread/chocolate identities and a contradictory Suja alias.
  Offline replay: 4 quarantined, 8 needs-review, none activated. Next: audited
  correction persistence and source-grounded identity review, then separate runtime
  integration; this is not a deployed matching fix. No production writes,
  commit or deployment. See `docs/backlog/catalog-knowledge-backfill.md` for exact
  results, projection limits and private artifacts. Full suite: 230 tests pass;
  11 new evidence-policy tests; scoped lint passes. No further Gemini calls.

- 2026-09-12 initial Product Intelligence release: Saturday Prep / Review picks
  removed; inline Ideas and Product Memory retained. List and Products share
  bounded search terms from current semantic profiles and household aliases.
  Search is retrieval only, not a change to receipt matching or recommendation
  scoring. See `docs/backlog/product-intelligence-roadmap.md` for coverage gaps
  and the next checkpoints. No migration or new provider calls in this release.
  Released successfully as Sites 93, source
  `a0a59ad16f555238f7d4992da4f87649932c4728`; prior release 92 is the rollback.
  Existing workspace access was preserved. 204 tests, build and scoped lint pass;
  local mobile/desktop search checks pass. Production errors-only logs were empty
  after release, but the direct authenticated smoke request returned 401, so a
  signed-in household browser smoke remains unverified. No access weakening.

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

## 2026-08-23 private app release

- The receipt/camera hardening, standalone purchase/return support, historical
  correction flow, Product Memory/Saturday Prep work, background image-job
  source, and Product Understanding and Intent Matching v1 were committed as
  `9dd651f1b02cd72af049993379f24c6782ec5112` and deployed as private Sites
  version 84.
- The app-owned migration gate completed migration 0014. The live `DB` binding
  now contains `product_understandings` and `intent_fulfillments`; the migration
  ledger reports 0014 completed.
- The separate `workers/receipt-ingestion/` Worker was not deployed. Its image
  jobs may remain queued until the legacy e-mail binding is removed and that
  Worker receives its own approval.
- Post-release authenticated smoke passed for List, Insights, Products, and
  Recap. The owner sandbox check/uncheck round trip restored its original state,
  receipt capture exposed camera/photo/PDF entry without an error, and the
  post-canary Site error log contained no events.
- Local release gates passed immediately before deployment: production build,
  BasketSense-only TypeScript, targeted lint, diff checks, and 158/158
  BasketSense tests. Good Cart Day was excluded from every release command.

## 2026-08-23 intent matching and recommendation shadow release

- Household Intent Matching was committed as
  `090e562e2885c3562d90142ed9c83c8766c324fc` and deployed as private Sites
  version 85 without changing the existing D1/R2 bindings or access revision
  21.
- Review corrections now permanently distinguish `same_product`,
  `fulfills_intent`, `substitute`, and `not_same`. Only `same_product` may
  teach catalog identity; the other relations preserve distinct products.
- Recommendation Engine v2 is deployed only as an owner-triggered backtest and
  invisible shadow evaluator. Migration 0015 adds household-scoped shadow
  evidence tables with no List foreign key. The visible Saturday policy and
  List remain unchanged, and the first production shadow cycle is still
  pending.
- Release gates passed with a production build, BasketSense-only TypeScript,
  targeted lint, diff checks, and 165/165 BasketSense tests. The authenticated
  canary loaded the shared household without mutation, loaded the owner-only
  sandbox and receipt capture controls, and recorded no application errors.
  A fresh physical phone-camera capture remains the only unrepeatable check.

## 2026-08-23 visible Recommendation V2 cutover

- Saturday suggestion seeding now evaluates the reconciled household catalog
  with `household-catalog-v2.1`. Ordinary ideas have a six-item attention
  budget; configured essentials may appear in addition to that budget.
- The cutover is deliberately non-destructive. It removes obsolete V1/V2 rows
  only when they are recommendation-owned drafts. Manual rows and anything
  included or checked survive, and no non-essential V2 idea is auto-added.
- Recommendation V1 remains intact behind the single
  `visibleRecommendationEngine()` server switch. Commit
  `80674914b917d2d46e97044cdf905512283824ec` is deployed as private Sites
  version 86. The clean functional rollback is to flip that switch to `v1`
  and deploy; that path also removes V2-owned draft rows. Sites version 85 is
  the emergency binary rollback, but its older code does not know how to clean
  V2 draft IDs.
- Focused D1 tests prove candidate backfill, repeat-read idempotency, legacy
  draft cleanup, preservation of a legacy active choice, and unchanged
  owner-only diagnostic behavior.

## 2026-08-29 Recommendation V2.1 learning release

- Commit `a5fd1e0a3adddb7326cf62b4f5a9092b2b2497a8` is deployed as private
  Sites version 89.
- Explicit Add and Remove decisions now record one household-scoped
  recommendation response atomically with the List mutation. Freeze records
  provisional `kept` evidence only for untouched automatically included V2
  recommendations; unfreeze removes only that provisional evidence.
- Only completed earlier cycles contribute recommendation-response evidence to
  future scoring, preventing same-cycle leakage. No migration was required.
- Release gates passed with 179/179 BasketSense-only tests, targeted lint,
  scoped TypeScript, a production build, and zero post-deployment Site error
  events. Version 88 / commit
  `2ec13ff3019b92625a247d2e0da123067134e3a3` is the emergency binary rollback;
  the V1 server switch remains the functional rollback.

## 2026-08-31 receipt/order recovery and intent-resolution release

- The release candidate hardens both weekly and ad-hoc receipt review. A saved
  successful ingestion can restore a reopened zero-placeholder draft, genuine
  household edits stay authoritative, discard clears the entire draft state,
  and a zero-dollar purchase cannot become official spending.
- The receipt reader now recognizes Costco.com purchase/return confirmations,
  validates line arithmetic before accepting extraction, and sends incomplete
  drafts through the existing recovery reader. Discount lines remain excluded
  from product review/catalog while their combined value is retained once in
  the receipt discount total.
- Product Intent Resolution v2 separates exact-product aliases from broader
  intent aliases, refreshes stale semantic understanding, and lets completed
  Recaps benefit from newer trusted knowledge without writing on read.
- Release validation passed 198/198 BasketSense-only tests, targeted lint, a
  production build, and responsive localhost checks at 320, 390, 720, and
  1440 pixels in Warm, Light, and Dark themes. The authenticated local sandbox
  confirmed that untouched zero placeholders keep Save & compare disabled.
- Private Sites version 90 / commit
  `d0717d3ec1265bbad4f200517bc60e1281b08d36` is the pre-release rollback
  anchor. Leave additive schema changes in place during an application
  rollback.

## Released feature details

- The complete 2026-08-15 deployment manifest, risk register, mobile evidence,
  monitoring plan, and rollback runbook are in
  `docs/release-readiness-2026-08-15.md`. The recommended first release is D1
  migrations 0009–0013 plus the private Sites app; the separate staging receipt
  Worker is explicitly excluded until its old email workflow/sender binding is
  removed and independently approved.

- Saturday Prep is available as an optional, List-native three-step
  review of likely-due and check-at-home suggestions. Only an explicit Add
  changes the shared list; Skip, Later, Have enough, and Not sure remain
  device-local planning choices.
- Household Product Memory is available with the explicit choices
  Buy again, Pause for now, and Not for us. Choices are append-only,
  receipt-backed feedback, editable from Products, and can also be captured in
  receipt review. The newest explicit choice wins; Pause and Not for us keep a
  product out of future Saturday Prep seeds.
- Ad hoc Costco purchases and returns are available as standalone
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
  receipt. It is completed in the existing Sites `DB`.
- Migration 0010 creates only the product-image job table and its indexes. It
  is completed in the existing Sites `DB`; jobs remain queued until the
  separate Worker is approved.
- Historical Review and Receipt Capture Hardening v1 are released.
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
  and applies 0009–0014 idempotently against its actual Sites `DB` binding before
  new receipt/history/Product Memory handlers continue. This is required because
  the Sites-managed D1 is not visible in the owner's Wrangler account and the
  available Sites database connector is read-only; never guess a remote D1 ID.
- Migration 0014 adds cached, household-scoped product understanding, nullable
  interpretation provenance on receipt lines, and product-ID-independent
  `intent_fulfillments`. The optional text-only Gemini stage runs only for
  uncached receipt labels, never receives receipt totals or List state, and is
  failure-tolerant. Full behavior and release gates are in
  `docs/product-understanding-and-intent-matching-v1.md`.
- The app accepts an optional `GEMINI_RECOVERY_MODEL` for pass 2. It was not
  added during the 2026-08-23 release, so pass 2 uses the primary configured
  model with the enhanced/section evidence. Automatic post-finalization
  Workflow recovery remains intentionally deferred with the broader async
  ingestion architecture; totals-only spending can be finalized now and the
  saved original remains available for an explicit re-read/correction.
- The 2026-08-23 release validation has 158 BasketSense tests passing, a passing
  production build, zero targeted lint errors, a passing BasketSense-only
  TypeScript check, sequential migration coverage, and the earlier authenticated
  owner-sandbox walkthrough at 320×568, 390×844, 430×932, and 844×390.

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
- Preserve the live access boundary and verify it before every deployment. On
  2026-08-29, the Site reported `workspace_all` at access revision 23, one
  account entry, no external visitors, and no workspace or tenant groups. This
  differs from the earlier custom two-account policy recorded on 2026-08-15.
  The owner explicitly approved version 89 while preserving this policy
  unchanged. Do not print or copy account identifiers into repository
  docs, and do not treat the older custom policy as current without a fresh
  Sites check.
- The latest verified production source commit is
  `a5fd1e0a3adddb7326cf62b4f5a9092b2b2497a8`, deployed as Sites version 89.
  Prefer a one-line `visibleRecommendationEngine()` switch back to V1 and a
  new deploy for a functional rollback. Sites version 88 / commit
  `2ec13ff3019b92625a247d2e0da123067134e3a3` is the emergency binary rollback;
  leave migrations in place during either rollback.

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
