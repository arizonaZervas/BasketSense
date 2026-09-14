# PI-2: catalog knowledge coverage and review-only backfill

Checkpoint: 2026-09-13. Runtime safeguards released as Sites 94, source
`10f2b326617a7ce3a28b77a4f5653bcae99ee239`. No production knowledge backfill or
activation. The deployment succeeded and the candidate table exists. Existing
workspace access was preserved; errors-only logs were empty. Authenticated HTTP
smoke returned 401, so live signed-in behavior remains unverified. Rollback is
Sites 93, retaining the additive table. Earlier checkpoint statements below are
historical, not the current release state.

## Follow-on: field-level review exports (local only)

The review export now includes a `reviewPacket` per product: each proposed name,
alias and attribute is marked supported, needs-review, or blocked, with the exact
source reference, source revision timestamp and relation. Useful supported terms
remain visible even when other terms require review. A supported term does not
authorize promotion; the aggregate conflict gate and `activationAllowed=false`
still apply. This is operator tooling, not a new customer-facing review screen.

Member-reviewed catalog names are now included as identity evidence, bringing the
offline evidence reader into line with the runtime safeguard. Member identifiers
are not included in the exported facts. A name does not independently establish
brand, product family, category or variant. `fulfills_intent`/`substitute` evidence
can support intent terms, never exact aliases; `not_same` blocks terms.

Evidence policy is `household-evidence-v2`; fingerprints invalidate when policy
or evidence changes. Preserve previous ledgers and consumed-call budgets; this
change is not permission to rerun generation. No new provider call, production
mutation, UI, or runtime recommendation change was made in this follow-on.
Validation: 237/237 BasketSense tests pass, including four new field-level review
cases and the read-only SQLite source integration; scoped ESLint passes. No
runtime source changed after the released build, so no second deployment is needed
for this operator-only increment.

Next bounded implementation: authenticated, revision-checked review persistence
and revocation, then selective promotion with search and matching canaries. Source
grounding of ambiguous SKUs and recommendation backtests remain separate gates.

## Evidence gate implemented — 2026-09-13

### Runtime integration implementation checkpoint — later released above

The receipt-understanding Worker now writes **new model output exclusively to
`product_understanding_candidates`**, never to active `product_understandings`.
The additive `0018_knowledge_candidates.sql` migration is generated and tested,
but has not been applied to production. The receipt path also uses idempotent
table creation consistent with its existing runtime bootstrap. Candidate keys
are household + SKU/raw-label key + prompt/schema versions. Repeated receipts
reuse the pending candidate without another generation; a new model alone does
not trigger retries. Concurrent first requests may both generate, but the first
insert wins and neither can activate knowledge. No budget limit was added to
the production reader in this slice.

`product-knowledge-policy.ts` applies household evidence precedence on every
active model consumer: core search terms, typed-list semantic attachment,
receipt draft metadata validation, receipt matching, and Worker cached reads.
If a catalog product has member-reviewed metadata, a confirmed alias, or explicit
intent feedback for its SKU, its model profile is excluded. The existing catalog,
exact aliases and separately typed intent decisions remain available. This is
intentionally conservative; it can remove useful older model synonyms for a
confirmed product as well as conflicting ones. No historical aliases are repaired
or reclassified automatically. New model output is not attached to receipt drafts;
unknown items retain the existing raw-label/manual-confirmation fallback.

This does not yet ship a candidate approval UI, automatic verified-SKU lookup,
or a changed recommendation algorithm. The existing product metadata confirmation
API provides durable corrected names; it now takes precedence over stale model
metadata, including a draft already open on another device. Until audited promotion
is implemented, newly generated synonyms will **not** automatically improve search.
Legacy unconfirmed model profiles remain available; they have not been blanket
audited or certified correct by this change.

Validation: **233/233 BasketSense tests pass**, scoped ESLint passes, receipt Worker
TypeScript passes, and the BasketSense production bundle builds successfully.
New real-SQLite integration tests exercise the owner-only sandbox API, separate
household candidate caches, repeat-read call suppression, unchanged list/catalog
data, member metadata correction via the real API, stale draft rejection, and
additive migration idempotency/uniqueness/foreign keys. Provider calls are mocked;
no additional real Gemini calls or production writes occurred. No UI changed;
browser/physical-phone live checks are not claimed.

Release/rollback: deploy the app and any separately running receipt Worker from
the same reviewed source, and keep the additive candidate table on rollback.
Older code ignores that table, so pending guesses cannot become active merely
through rollback. Older code may resume its former direct-write behavior for
future requests; rolling back removes the new safeguard. Do not claim a live
sandbox check until a release is actually deployed and authenticated there.

`scripts/catalog-knowledge-evidence.mjs` now assesses proposals in the local
review export. The source reader carries household-confirmed aliases and the four
intent relations with source IDs/timestamps, scoped to the household and product.
Receipt/historical aliases without a confirming member are not household evidence.
A legacy alias can still have `confirmation_source=receipt` after a member update;
the persisted confirming-member field is therefore used, not that source label alone.

- `same_product` evidence supplies protected exact terms. `fulfills_intent` and
  `substitute` supply separate intent terms, never identity aliases. `not_same`
  blocks conflicting proposals. Existing contradictory decisions are held rather
  than resolved by guessing or silently rewriting household history.
- New identity wording, distinct-SKU alias collisions and existing family/category
  disagreements quarantine a proposal. Unconfirmed expansions stay `needs_review`.
  Brand/variant/alias additions require support too. Matching is deliberately exact
  and conservative: disagreement can mean different wording, not a proven error.
- `consistent_with_confirmations` means the proposed terms echo known evidence,
  **not** that activation is authorized. All assessments set `activationAllowed=false`.
  Ledger state `proposed` still denotes structural validity only; consumers must
  inspect `assessment`. There is still no promotion command or runtime integration.
- Evidence and prior profiles are included in fingerprints. Backfill version is
  now `catalog-review-v2`: preserve the original pilot ledger/results, and do not
  reuse its v1 ledger for new generation or bypass its consumed request budget.
- Provider payload is unchanged: household corrections are evaluated locally, not
  sent to Google. No new model requests were needed.

Read-only live audit consumed 83 alias rows and 8 fulfillment rows, separated by
household. For the primary household, bread SKU 1860779 and chocolate SKU 401621
had no member-confirmed aliases/fulfillment records. Their chat corrections must
not be presented as already-persisted authoritative app evidence. Suja Digestion
has a confirmed `Suja ginger shots` alias, plus a separate `Immune shots` substitute
decision. These are existing records, not changes made by this task.

Replaying the original 12 outputs with the audited evidence produced **4 quarantined
and 8 needs-review** proposals; zero became eligible for activation. Bread was held
for an existing profile-family disagreement; chocolate lacked confirmed identity;
Suja exposed a distinct-SKU collision. Oranges and Downy were also conservatively
held. This is safety coverage, not a claim of improved live search accuracy.
All **230 BasketSense tests passed**, including 11 new evidence-policy tests and
the 15 backfill tests; scoped ESLint passed. Actual read-only SQLite tests cover
confirmation/intent extraction and unchanged source bytes. No UI was changed,
so no new mobile/desktop smoke test or build was needed.

Next: a reviewed, auditable way to persist missing/corrected identity evidence,
resolve contradictory historical aliases, and ground ambiguous SKU expansions.
Then separately integrate/promote validated knowledge into runtime consumers.
The broad overhaul is not complete; do not deploy these operator scripts and
claim the live matching problem is fixed.

Billing correction: the owner supplied a screenshot showing **No billing account**.
For that key/project, the pilot was free-tier usage. $0.0047646 below is only its
paid-rate equivalent, not an observed charge. Billing was not enabled or changed.

### Approved pilot preflight — 2026-09-13

The owner approved proceeding with the bounded pilot and supplied the key in
Git-ignored, owner-readable `.env.local`. Key presence was verified without
displaying it. An authenticated Gemini model-metadata request succeeded; the
model advertises 1,048,576 input and 65,536 output tokens. At the rates below,
the full model token envelope is $0.4784128 for one request (not an invoice).

The owner subsequently explicitly approved sending 12 catalog labels and Costco
item numbers to Google's Gemini API. The pilot completed with **one generation
request and zero production writes**. Sites' production secret remains unchanged.
The earlier safety rejection and a local URL-encoded path error both happened
before generation; neither consumed a generation request. The local driver now
uses `fileURLToPath` to handle the space in the repository path.

The read-only live product/profile projection was refreshed (318/36 rows). A
12-product shortlist and 20 retrieval canary assertions were recorded before any
model output in ignored `tmp/catalog-knowledge/pilot-20260913.mjs`, with the
private source projection alongside it. This projection uses catalog names,
not freshly exported receipt labels or learned aliases, and is not transactional.
It sends only selected labels/SKUs, never household IDs, prices or receipts.
Private artifacts now include `pilot-20260913.sqlite` and
`pilot-20260913-results.json` under that ignored directory. Do not rerun generation
or increase its one-request budget without a new scoped decision.

### Completed pilot: useful expansion, unsafe automatic activation

- Model `gemini-3.5-flash-lite`; HTTP 200, normal `STOP`; 4,658 ms wall time.
- 932 input tokens, 1,794 output tokens, 0 reported thinking tokens; estimated
  cost **$0.0047646** at the rates below, not a billing invoice.
- All 12 responses passed structural validation and the >=8000 confidence filter.
  This is **not** 12 verified identities: high-confidence errors survived it.
- Against the local 312-product projection, desired retrieval checks improved
  from **11/14 to 13/14**, but exclusion checks fell from **6/6 to 4/6**.
  Overall checks remained 17/20. These are predeclared canary query/SKU checks,
  not representative precision/recall, ranked top-k evaluation or live UI tests.
- Bounty became findable by `paper towels`; ZIPLC SLIDER by `ziploc bags`.
  Downy was already findable using existing profiles, so this run does not prove
  an incremental Downy improvement.
- **Reject:** SKU 1860779 was proposed as Naked White Juice (9000 confidence),
  contrary to the owner's bread correction. Existing bread terms masked this
  error in the additive search test: inspect identity correctness separately.
- **Reject:** SKU 401621 was proposed as chicken nuggets (8500 confidence),
  contrary to the owner's Hershey's chocolate correction. It introduced a false
  chicken result and still missed the desired chocolate query.
- **Hold:** Suja Digestion gained `ginger shots` as an intent alias. That violates
  this household's strict variant-separation canary; it is not evidence that the
  products share an exact identity. Broad related-product retrieval needs a
  separate, explicit policy from exact receipt matching.
- **Unverified:** the tissue SKU was proposed as facial tissue, not toilet paper.
  No independent SKU evidence was supplied to establish that identity.
- The model asserted `exactSkuKnown=true` for all 12. Treat this as an unsupported
  model assertion, never a substitute for a verified source or household decision.

**Decision: do not activate any proposals or expand the backfill yet.** Next
ticket is evidence-aware candidate validation: household-confirmed identities
take precedence; include existing trusted knowledge in review; quarantine family
conflicts; require source evidence for ambiguous SKU expansions; keep exact aliases
separate from broader intent terms. Add these observed errors to regression cases
before another bounded evaluation. No matching or recommendation changes shipped.

Projection caveat: receipt labels and the full household-alias table were not
exported. The driver attaches profiles by SKU, so its coverage summary is
20 ready / 292 missing, omitting the earlier audited uncertain raw-label profile.
This is a projection limitation, not a production coverage regression. Retrieval
results compare this same projection before/after; they are not exact live search.
The 15 focused operator tests passed again after the pilot; the earlier full
219-test result remains the last full-suite check. No runtime code was modified.

The current source default is `gemini-3.5-flash-lite`. Google's current
[standard pricing](https://ai.google.dev/gemini-api/docs/pricing#gemini-3.5-flash-lite)
lists US$0.30/M input tokens and US$2.50/M output tokens including thinking.
Recheck actual request/token bounds and billing-tier privacy before the call;
these rates alone are not an invoice or hard dollar cap.

For future runs, supply a key from the approved Gemini project in
the local process environment, or a private Git-ignored `.env.local` file. Never
paste it in chat or commit it. For the latter, use Node's `--env-file=.env.local`
before `--import tsx` when invoking the operator tool; the key then enters the
process environment without appearing in command arguments or output. Keep the
file owner-readable only. Refresh the source snapshot before running the pilot.

## What we verified

Read-only Sites database inspection of the existing BasketSense `DB` succeeded.
All pages were consumed: 318 product rows and 36 understanding rows, separated by
household. No receipt images, full receipt contents, or member records were read.

| Scope | Active products | Ready | Uncertain | Missing/current version absent | Malformed |
| --- | ---: | ---: | ---: | ---: | ---: |
| Primary household, live | 312 | 20 | 1 | 291 | 0 |
| Owner sandbox, live | 6 | 0 | 0 | 6 | 0 |
| Primary household, local snapshot | 267 | 1 | 0 | 266 | 0 |

Four of the primary household's 291 missing-current profiles have an old version;
five of the sandbox's six do. Primary household understanding rows total 31, but
only 25 join to active catalog identities. The Bounty, tissue and bath-towel rows
have no understanding profile. A tissue label alone does not establish whether it
is facial tissue or toilet paper; that distinction must be reviewed, not guessed.

“Ready” means current prompt/schema, structurally valid profile, confidence ≥8000,
family plus nonempty exact and intent aliases. It does **not** mean human-verified
identity or measured accuracy. Model confidence is only a filtering signal.
Paginated live inspection is not a transactional snapshot and can drift if the
household edits its catalog during collection. Recheck before a live pilot.

## Implemented boundary

- `scripts/catalog-knowledge-backfill.mjs`: explicit operator CLI; default run is
  a dry-run. Not imported by the app, exposed as an API, or triggered on a poll.
- `scripts/catalog-knowledge-backfill-lib.mjs`: coverage, evidence fingerprints,
  persistent local SQLite ledger, strict model-response validation and review
  export. Reads a local source database with a read-only connection/transaction.
- Reuses the existing Gemini request/response contract. Sends only SKU and product
  label, not household/product IDs, prices, list text, photos or member details.
- One invocation makes at most one request containing at most 20 products.
  An optional product-ID shortlist supports a targeted pilot. Keys are validated
  against the current ledger and never sent to Gemini.
- Every provider call is reserved transactionally before sending. The explicit
  cumulative request limit includes failed and interrupted calls across restarts.
  No automatic retries; errors require `--retry-errors`. An abandoned batch needs
  explicit recovery after stopping the old process. Late responses cannot apply.
- Fingerprints include household, product evidence, model, prompt/schema and
  backfill version. Changed evidence queues only changed products. Removed items
  leave the current workset. Old proposals remain archived in the local ledger.
  Model/contract changes require a new ledger; unchanged completed work is reused.
- Responses become `proposed`, `uncertain`, or `error`, never active knowledge.
  Missing SKU, low confidence or incomplete semantics remain uncertain. Missing,
  duplicate, unknown and malformed response records cannot become ready proposals.
- Existing `product_understandings`, catalog identity, financial facts, matches,
  list items and recommendation learning are never written by this tool.
  There is deliberately **no promotion/import command** yet.

Provider response bytes are bounded to 256 KB; timeout is 30 seconds. Only normal
`STOP` completion is accepted, not token-limit truncation, per the current
[Gemini response contract](https://ai.google.dev/api/generate-content#FinishReason).
The output cap remains the existing 8,192 tokens. Large or uncertain responses
stay reviewable errors rather than partial active profiles.

## Operator workflow

Use a current **BasketSense-only**, owner-authorized local SQLite snapshot. Do not
point at Good Cart Day resources. Do not commit the source or generated artifacts.
The CLI restricts writable artifacts to the already-ignored
`tmp/catalog-knowledge/`, with private file modes; it rejects symlinked destinations
and refuses to use a household database as its ledger.

Run from the BasketSense repository using Node with `node:sqlite` and installed
`tsx`. Replace placeholder values; never put a provider key in a command argument
or a tracked file. Prefer a securely supplied process environment.

```sh
node --import tsx scripts/catalog-knowledge-backfill.mjs coverage \
  --source-db LOCAL_SQLITE_SNAPSHOT --household HOUSEHOLD_ID

node --import tsx scripts/catalog-knowledge-backfill.mjs prepare \
  --source-db LOCAL_SQLITE_SNAPSHOT --household HOUSEHOLD_ID \
  --model APPROVED_MODEL --ledger tmp/catalog-knowledge/pilot.sqlite

node --import tsx scripts/catalog-knowledge-backfill.mjs run \
  --household HOUSEHOLD_ID --ledger tmp/catalog-knowledge/pilot.sqlite
```

That final command is a dry-run: **zero provider calls**. `report` prints aggregate
coverage and job states; `review --output tmp/catalog-knowledge/review.json`
exports private evidence/candidates and refuses to overwrite an existing file.

Only after owner approval of provider usage and a verified price/limit estimate:

```sh
node --import tsx scripts/catalog-knowledge-backfill.mjs run \
  --household HOUSEHOLD_ID --ledger tmp/catalog-knowledge/pilot.sqlite \
  --execute --request-limit 1 --product-ids PRODUCT_ID_1,PRODUCT_ID_2
```

`GEMINI_API_KEY` must already be securely supplied in the operator environment.
Increasing `--request-limit` explicitly authorizes more cumulative requests for
that ledger; it is **not a dollar-denominated billing cap**. Do not create fresh
ledgers to bypass the approved overall budget. The roadmap's proposed US$1 cap
still needs current model pricing, input/output/thinking accounting and owner
approval before any further call. The single completed pilot above is the only
paid generation request made for this checkpoint.

For interruptions, stop the original process, run `recover --confirm-interrupted`,
then explicitly retry errors with sufficient remaining request allowance. Unknown
provider outcomes continue to count as spent calls. Re-run `prepare` against a
fresh source snapshot before each operator session; offline evidence does not
automatically follow subsequent live changes.

## Validation and remaining gates

**219/219 BasketSense tests pass**, including the 15 new cases. Scoped ESLint and
diff whitespace checks pass. No runtime bundle changed; no fresh production build
or deployment was necessary for these operator scripts.

15 new tests exercise coverage, fingerprints, batch/restart idempotence, targeted
pilots, contract invalidation, household isolation, failure/recovery, strict parsing,
provider payload boundaries, actual read-only SQLite source preservation and CLI
dry-run/path protection. Synthetic Bounty/toilet-paper/towel/citrus profiles verify
the search integration and hard negatives; they are not model-accuracy evidence.

The first 12-product paid pilot is complete and failed the semantic activation
gate. Address evidence precedence and conflict quarantine first; then obtain a
fresh authorized source snapshot and separately budget any repeat evaluation.
Only after semantic quality passes design an explicit, audited activation path
with evidence freshness checks and independent rollback. Do not bulk overwrite
the shared active profile table: existing matching also consumes it.

No customer-facing surface or runtime path changed, so this checkpoint adds no
mobile/desktop interaction to test or deploy. Existing UI behavior is covered by
the BasketSense regression suite; this is not a fresh physical-phone smoke test.
The full PI-2 production backfill/activation gate remains open. PI-3–PI-6 are not
implemented by this tooling change.
