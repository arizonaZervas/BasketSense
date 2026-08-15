# BasketSense release readiness — 2026-08-15

## Conclusion

**The private BasketSense app is ready for owner review, but it should not be
released as one undifferentiated big-bang deployment.** The safe release is:

1. capture production invariants and retain Sites version 69 as the code rollback;
2. let the app-bound migration gate apply migrations 0009 through 0013 in order
   against the actual Sites `DB` binding before any new handler continues;
3. deploy only the private Sites app;
4. run owner-sandbox and read-only household smoke checks;
5. monitor before considering the separate receipt Worker.

The receipt Worker is **not part of the recommended first release**. Its local
code contains the durable product-image processor, but its staging-only config
still includes an old trip-email workflow and sender binding that is outside
the approved BasketSense release boundary. Product-image jobs can safely remain
queued until that Worker is separately cleaned, staged, and authorized.

The release gate is idempotent, records applying/completed/failed status in D1,
and retries a failed step on the next request. This avoids guessing a remote D1
identifier: the Sites-managed database is not listed in the owner's Wrangler
account and the Sites database connector is read-only. No production household
state was changed while preparing this report.

## Live baseline to preserve

- Private Sites version: **69**.
- Exact deployed Git source: `067d4d44c585336ffbaa68c5220b56153c8032d5`.
- Access mode: custom policy revision 16, exactly two account users, no external
  visitors. Preserve this policy exactly.
- The production D1 schema is still the pre-release schema: it does not contain
  `product_image_jobs` or `receipt_corrections`.
- Existing D1 and R2 bindings remain the release targets. Do not create or
  substitute a database, bucket, or Sites project.
- Current error-only logs contain canceled `/api/household?view=core` requests
  and missing icon requests. These are baseline noise and should be separated
  from new 5xx, migration, authorization, or data-integrity errors.

## What the private app release contains

### 1. Saturday Prep and Product Memory

- An optional List-native Prep flow for likely-due and check-at-home ideas.
- Only an explicit **Add** changes the shared List.
- Explicit household Product Memory choices: Buy again, Pause for now, and Not
  for us. Receipt cadence alone never makes this decision.
- The latest explicit household choice shapes future Prep suggestions.

### 2. Ad hoc Costco purchases and returns

- Insights gains **Add Costco receipt** for Costco.com orders, tires, jewelry,
  precious metals, and other purchases outside the weekly trip.
- The same flow accepts returns; a finalized return is stored as signed negative
  receipt evidence and reduces overall Costco spending.
- Drafts do not affect official metrics. Only explicit finalization changes
  spending and product history.
- Standalone transactions use `receipt_transactions.trip_id = NULL`; no fake
  Saturday trip is created.
- The upload contract accepts PDF, JPEG, PNG, WebP, HEIC, and HEIF.

### 3. Catalog promotion and background image jobs

- Newly finalized receipt products are linked or promoted into the household
  catalog, including products seen on standalone returns.
- Discounts never become catalog products.
- Catalog promotion does not create Product Memory and does not add anything to
  the shared List.
- Products without an approved primary image receive one durable background
  `product_image_jobs` entry.
- The app release queues these jobs; the excluded Worker is required to process
  them. A queued or failed image job does not block receipt finalization or
  spending accuracy.

### 4. Receipt Capture Hardening v1

- The private source file is saved before extraction.
- Photos are compressed by readable receipt width, not short-screen height.
- Long photos produce a de-shadowed full image and overlapping vertical
  sections for a recovery pass.
- The original file is read first; incomplete or failed reads can use recovery
  evidence and an optional `GEMINI_RECOVERY_MODEL`.
- PDFs remain native and are sent with their original MIME type.
- Failures expose a clear saved/retry/manual-total state instead of an ambiguous
  spinner. Retry reuses the same ingestion rather than starting a competing
  extraction.
- Diagnostics store only safe error codes, provider IDs, pass number, and
  timing—not receipt contents.
- Exact totals-only receipts remain usable when product lines cannot be read.

### 5. Historical Recap and receipt correction

- Recap lazily lists completed weekly trips and opens the selected trip's own
  receipt comparison.
- Both household members can view history; only the owner can apply a
  historical correction.
- A correction can re-read the saved private original or accept a replacement
  image/PDF.
- The current receipt stays official until the owner reviews and applies the
  replacement.
- Applying a correction preserves the frozen plan and final List, rebuilds the
  receipt comparison, and keeps the prior receipt JSON, lines, matches,
  questions, and upload pointer as revision evidence.
- The mobile stale-screen flash found during validation is fixed: every receipt
  flow remounts at its requested first step, so opening **Correct receipt** can
  no longer briefly claim that a correction was already applied.
- Scope limit: v1 history/correction covers completed weekly trips. Standalone
  purchase/return history correction remains a future extension.

### 6. Weekly checkout correctness

- Checkout comparison uses the **final shopping-list estimate**, including
  products added while shopping.
- The original frozen estimate remains visible as intent evidence, but is no
  longer incorrectly used as the only checkout baseline.

### 7. Mobile and accessibility polish

- Receipt, correction, List, Insights, Products, product detail, and Recap
  reflow without horizontal overflow in the tested phone layouts.
- Close, Sign out, List Undo, product Add, and Insights scope controls now keep
  a 44px touch target.
- The correction dialog is internally scrollable and remains within the narrow
  viewport.

## Database migrations

The private app applies these exact upgrades in order against its bound `DB`:

| Migration | Change | Compatibility and risk |
| --- | --- | --- |
| 0009 | Makes only `receipt_ingestions.trip_id` nullable | Rebuilds that table, copies every existing column and row, preserves foreign keys, then recreates its five named indexes. This is the highest-risk migration because it rewrites an existing table. |
| 0010 | Adds `product_image_jobs` and indexes | Additive. Old app versions ignore it. |
| 0011 | Adds `receipt_corrections` plus safe ingestion diagnostic/recovery columns | Additive. Old app versions ignore the table and nullable columns. |
| 0012 | Adds/backfills/indexes `feedback.product_id` for Product Memory | Additive after deterministic backfill from the referenced receipt line. |
| 0013 | Adds `basketsense_schema_migrations` | Additive migration ledger and concurrency gate. It prevents two fresh edge isolates from rebuilding the ingestion table at the same time and makes failed steps retryable. |

The five migrations and the app-bound upgrade path were rehearsed against a
pre-0009 D1-compatible SQLite database. Existing ingestion rows and indexes
survived, Product Memory backfilled deterministically, a simulated failed step
was reclaimable, a second run was a no-op, and `PRAGMA foreign_key_check`
returned no violations. Production has not been migrated at report time.

## Exact size and delivery surfaces

- 25 tracked BasketSense files are modified: **5,782 additions and 367
  deletions**.
- 20 untracked BasketSense files add 18,936 lines. Of those, 17,245 lines are
  generated Drizzle snapshots and 1,691 are handwritten source, migrations,
  tests, and this readiness report.
- Total review scope: 45 BasketSense paths.
- `AGENTS.md` is a local collaboration instruction and is not a runtime
  artifact; exclude it from the release commit unless the owner explicitly
  wants repository-level agent instructions versioned.
- Tests, docs, Drizzle snapshots, and schema source belong in the reviewed
  source commit but are not runtime payloads.
- Sites runtime payload: app routes/components/styles plus shared receipt
  extraction code imported by the app.
- D1 runtime payload: migrations 0009–0013, applied by the app-bound migration
  gate before new receipt/history/Product Memory handlers continue.
- Deferred runtime payload: `workers/receipt-ingestion/` product-image and
  extraction Worker changes. Do not deploy this surface in phase one.

## Validation evidence

### Automated

- Production build: passed.
- BasketSense-only test suite: **128 passed, 0 failed**.
- Lint: **0 errors**. Five warnings remain only in generated Worker types and an
  existing Playwright tutorial artifact.
- Separate Worker TypeScript, generated-binding check, and Wrangler dry-run:
  passed. The dry-run also confirmed the unapproved legacy email/workflow
  bindings, which is why this otherwise buildable Worker remains excluded.
- `git diff --check`: passed.
- Final BasketSense-only knowledge graph: 7,321 nodes and 12,538 edges.
- `DataHealthExplorer`: zero graph matches; it is not in the UI graph.

### Real local authenticated mobile sandbox

The local app used the same owner identity boundary and the isolated
`?sandbox=1` household. These are representative authenticated results, not
production writes.

| Layout | Surfaces exercised | Result |
| --- | --- | --- |
| 320×568 | List, Insights, Products, product detail, Recap, ad hoc receipt, historical correction | No horizontal overflow; dialog stayed within viewport; visible controls at least 44px after fixes. |
| 390×844 | Same surfaces plus purchase, return, weekly receipt completion, Product Memory | Passed. |
| 430×932 | Primary surfaces and both receipt entry dialogs | Passed. |
| 844×390 | Landscape navigation and receipt dialogs | Passed with no document/dialog overflow. |

Additional flow evidence:

- An image file reached the standalone receipt path, was saved privately, and
  fell back clearly to manual totals when local automatic reading was absent.
- A synthetic PDF reached the real receipt-ingestion route and returned 202;
  the resulting sandbox draft was then discarded.
- A $10 sandbox standalone purchase finalized and appeared in Insights and
  Products; its new SKU was promoted into the catalog.
- A $4 sandbox return finalized and reduced net spend from $10 to $6.
- The standalone resume marker cleared after finalization, preventing the next
  receipt from reopening the completed transaction.
- A weekly totals-only sandbox receipt completed and compared checkout against
  the final shopping-list estimate.
- The same weekly upload request recovered idempotently after an intentionally
  stale local schema caused the first attempt to fail.
- Correction opening was sampled across consecutive animation frames at every
  mobile viewport; every frame showed **Choose the replacement receipt**, and
  no false **Historical correction applied** state appeared.

The narrow correction screenshot is retained as local evidence at
`.playwright-mcp/correction-320x568.png`; it is not a release artifact.

## Risk register and stop conditions

| Risk | Mitigation | Stop/rollback trigger |
| --- | --- | --- |
| 0009 table rebuild loses or miscopies an ingestion row/index | Atomic D1 batch, migration ledger/concurrency claim, pre/post counts, preservation tests, handler gate | Any row-count mismatch, missing index, or foreign-key violation |
| Signed returns or discount normalization distort totals | Integer-cent contracts, return/category tests, sandbox purchase/return | Any unexplained change to existing net household spend |
| OCR still fails on a difficult real photo | Original preserved, two-pass recovery, explicit retry, totals-only fallback, historical correction | Upload disappears, duplicate transaction appears, or UI cannot resume/retry |
| Automatic catalog promotion creates noisy products from bad OCR | Only finalized product lines promote; original text retained; category remains reviewable | Large unexpected product-count jump or discounts appearing as products |
| Historical correction changes more than receipt evidence | Owner-only apply, preview, revision archive, frozen plan/final List immutable | Trip/List/intent rows change during correction or prior revision is missing |
| Large app diff hides a navigation/mobile regression | Four-layout walkthrough and owner-sandbox canary | Core/List, navigation, or receipt dialog fails on either phone |
| Product image Worker sends or touches an unapproved integration | Worker excluded from phase one | Do not proceed while legacy email workflow/sender binding remains |
| New failures are hidden by current log noise | Filter canceled core polls and icon 404s; monitor new route/status signatures | New sustained 5xx, 401/403 for allowed users, or migration errors |

## How we will know if the release is healthy

### Before release

1. Record Sites version 69 and commit `067d4d44c585336ffbaa68c5220b56153c8032d5`.
2. Reconfirm the custom two-account access policy and zero external visitors.
3. Record counts for receipts, items, products, feedback, ingestions, and
   reconciled totals. The captured live baseline is 275 products, 43 receipt
   transactions across the shared and sandbox households, 550 receipt items,
   11 feedback rows, and 14 ingestion rows. The shared Insights baseline is 42
   reconciled receipt transactions and $6,975.61 household-funded spend.
4. Verify the existing Gemini secret without printing its value. Decide whether
   to set `GEMINI_RECOVERY_MODEL`; absence is safe because pass two falls back
   to the primary model.

### Canary immediately after migration and app deployment

1. Sign in as the owner and verify List, Insights, Products, and Recap load.
2. Confirm the second allowed household account can still sign in and cannot
   use owner-only correction/sandbox actions.
3. In the owner-only sandbox only:
   - add/check/remove a List item;
   - upload one synthetic image receipt and one synthetic PDF;
   - finalize one purchase and one return;
   - open a completed trip correction but do not apply unless the synthetic
     correction is part of the planned canary.
4. In the real household, remain read-only: compare the displayed audited total,
   receipt count, product count, latest transactions, and a historical recap
   with the pre-release record.

### Operational checks

Inspect immediately, at 15 minutes, one hour, and the next day:

- Sites deployment status and active version;
- new 5xx by `/api/household`, `/api/receipt-ingestion`,
  `/api/receipt-photo`, and `/api/product-images`;
- unexpected 401/403 for either allowed account;
- `receipt_ingestions` grouped by status, attempt count, extraction pass, and
  safe error code;
- count of `receipt_corrections` and revision sequence gaps;
- `product_image_jobs` grouped by status (queued is expected until the Worker
  is released; failed is not an app-release blocker);
- reconciled transaction count and signed sum of `total_cents`;
- products created since release, especially item `0000` or discount-like text;
- `PRAGMA foreign_key_check`.

There is no automated alert configured today. This release therefore requires
an owner-present canary and manual log/data checks; a successful build or Sites
deployment alone is not production proof.

## Rollback story

### App regression without data corruption

Roll the Sites app back to saved version 69 / commit
`067d4d44c585336ffbaa68c5220b56153c8032d5`. Leave migrations 0009–0013 in
place. They are backward-compatible with version 69: new tables and nullable
columns are ignored, and making `receipt_ingestions.trip_id` nullable does not
invalidate existing trip-linked rows.

Do **not** try to reverse the migrations during an incident. A code rollback is
faster and avoids a second table rewrite.

### One bad receipt or correction

Prefer targeted repair. Historical correction revisions retain the prior
receipt totals, items, matches, questions, and R2 pointer. Restore or reapply
that evidence instead of rolling back the whole household database.

### Confirmed database-wide corruption

Use D1 Time Travel only after confirming corruption. The current Sites tools do
not expose a bookmark or arbitrary SQL/export operation for this managed
database, and the database is not visible to the owner's Wrangler account; do
not guess an identifier. Escalate through the Sites database management surface
before a destructive restore. Record/export the damaged state for diagnosis
first when safe, put the app into a no-write maintenance window, restore, then
re-run invariants before reopening writes.

Cloudflare documents that Time Travel is always available and that restore
overwrites the database: <https://developers.cloudflare.com/d1/reference/time-travel/>.
Its SQL export path can provide an additional pre-release snapshot, but a full
export blocks database requests while it runs:
<https://developers.cloudflare.com/d1/best-practices/import-export-data/>.

### R2 and deferred Worker

A Sites code rollback does not delete new private R2 objects. Receipt and image
keys are unique, so leave any orphaned objects for later audited cleanup rather
than deleting during the incident. If the Worker is released later, save its
own previous version and roll it back independently; Cloudflare Worker rollback
does not roll back bound D1/R2 data:
<https://developers.cloudflare.com/workers/versions-and-deployments/rollbacks/>.

## Recommended release ticket

**Release ticket: BasketSense private app canary — migrations 0009–0013 plus
Sites app, Worker excluded.**

Acceptance criteria:

- exact access policy unchanged;
- pre-release invariants captured and version 69 retained;
- migrations apply with matching row/index counts and no foreign-key failures;
- Sites app reaches success and reports a new version;
- owner-sandbox image/PDF, purchase/return, List mutation, and correction-open
  checks pass on both phones;
- real household totals/history remain unchanged by the read-only smoke;
- no new sustained 5xx/auth/migration signature through the one-hour checkpoint;
- rollback to version 69 is kept available until the next-day check passes.
