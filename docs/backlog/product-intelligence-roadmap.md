# Product intelligence: search, intent matching, and recommendations

Date: 2026-09-12
Status: PI-0 and the existing-knowledge search slice of PI-1 implemented and
approved for deployment. PI-2 through PI-6 remain proposed, not implemented.
Scope: private BasketSense only. Separate user approval authorized the initial
release; this plan does not authorize provider-data expansion or Good Cart Day work.

## Decision in brief

Make product understanding the next major household-quality investment. Improve
catalog discovery first, receipt matching second, and recommendation timing third.
Reuse the existing semantic profiles and durable feedback instead of replacing
them with another abbreviation dictionary or an LLM call on every interaction.

Retire the Saturday Prep / Review picks wizard as a separate small change. Keep
inline Ideas, Product Memory, and the useful post-trip correction questions.
See [feature graveyard](feature-graveyard.md). Retirement is included in this release.

### Initial implementation checkpoint — 2026-09-12

- Removed the Review picks wizard. Inline Ideas, Product Memory and post-trip
  correction questions remain unchanged.
- List quick-add and Products use one search policy over existing names, raw
  labels, SKU and bounded household search terms. Terms include learned product
  aliases and current-version semantic name/brand/family/variant/intent aliases.
  Profiles below 80% model confidence are excluded; that threshold is a filter,
  not a claim of measured accuracy. Generic terms retrieve candidates only.
- The extra knowledge queries share the core D1 batch. Five-second list polls
  do not read them. No new schema, provider calls, product merges or receipt edits.
- API tests cover household isolation, stale/low-confidence profiles, malformed
  JSON, unchanged lists/history and poll isolation. Full BasketSense suite:
  204 passing tests; production build and scoped lint pass.
- A broader app type-check is not clean: untouched Recap nullability and the
  receipt worker's GEMINI_IMAGE_MODEL Env declaration produce eight diagnostics.
  No diagnostic points to the new search module or changed search/API sections.
  This is not recorded as a passing whole-project type-check.
- Local browser checks use 390px mobile, 320px narrow-pane and 1440px desktop,
  with existing themes. Semantic examples use explicitly synthetic browser-only
  profiles; they are not a production backfill or proof of live catalog coverage.
- Remaining gate for the next slice: measure live profile coverage and review
  missing historical SKUs. The initial local catalog has sparse profiles, so
  wiring search alone does not make every familiar term discoverable.
- Rollback: restore the previous application release (Sites 92). No database
  reversal is needed; this release does not modify household data or bindings.

The evidence below describes the pre-change research baseline, not the new code.

The owner's estimate that matching feels 60–70% complete is qualitative product
feedback, not measured accuracy. The objective is less typing, fewer repeated
corrections, and useful suggestions—not a larger auto-match percentage at any cost.

## Evidence inspected

Source baseline: `3d0d4485e2cd58bd1ab5a1a0ef55d949719e7cdc`. Production version and
live household records were not inspected in this research turn. Existing release
paragraphs elsewhere can be historical; this is a current source assessment.

Graph discovery used `basketsense-2`; its old temporary source was unavailable.
Reindexing a fresh BasketSense-only mirror completed with 6,479 nodes and 10,131
edges, but snippets still referenced the old path. Exact graph-discovered files
were therefore read directly. Good Cart Day files/resources were not inspected.

| Area | Verified source behavior | Consequence |
| --- | --- | --- |
| List catalog picker | `app/basket-sense-dashboard.tsx:2237`: token substring search over canonical name, latest raw label, item number and selection label; seven results | Semantic names, families and learned aliases do not participate in this picker. Better backend matching alone cannot fix what the user sees while typing. |
| Products search | `app/basket-sense-dashboard.tsx:4548`: substring search of name, raw description and item number | A second search implementation has the same knowledge gap and a different matching policy. |
| Typed item attachment | `app/api/household/route.ts:3084`: exact matches, then current-version SKU-joined semantic profiles through `resolveSpecificCatalogProduct` | The server has more knowledge than the picker; absent/stale profiles and missing SKU links can bypass it. |
| Identity resolver | `app/product-intent-resolution.ts:65`: exact names/aliases or descriptive subset; generic family aliases deliberately excluded | Correctly avoids silently binding broad requests to one SKU, but this conservative identity rule must not define search recall. |
| Understanding | `workers/receipt-ingestion/src/product-understanding.ts`: Gemini profiles include brand, family, variant, exact aliases and intent aliases; refresh operates on receipt draft lines | A layer already exists, but historical catalog coverage is not guaranteed. Model confidence and `exactSkuKnown` are generated claims, not independent verification. |
| Receipt matching | `app/receipt-logic.ts:791`: remembered positive/negative relations, SKU/product identity, normalized text, semantic rules, then token overlap | Semantic fallback for productless requests still relies on matching generated phrases. Exact wording and coverage remain important. |
| Assignment | `app/receipt-logic.ts:945`: sort scored pairs and greedily assign each intent and receipt once | Pair quality and whole-trip assignment are separate failure modes; receipt line grouping and competing intents need explicit tests. |
| Recommendations | `app/recommendation-engine-v2.ts:170`: per-product frequency, median intervals, recency, streak, quantity stability, outcomes and state | It is not merely receipt-string matching. SKU-fragmented histories and overly broad feedback can still hurt replenishment decisions. |
| Review picks | `app/saturday-prep.tsx:66`: localStorage status keyed by trip/date; Close sets idle; Finish Prep persists complete | A different browser/device cannot inherit completion. Leaving before Finish restarts. The parent keys only by trip ID, so date changes do not reinitialize state in place. Exact reported repeat session is not reproduced. |

Validation performed: 45/45 existing tests passed across
`tests/product-intent-resolution.test.mjs`,
`tests/household-intent-recommendation-v2.test.mjs`, and
`tests/receipt-logic.test.mjs`. A synthetic oranges/MANDARINS pair produced no
match without knowledge, then an automatic `confirmed_intent_fulfillment` match
with explicit feedback. This validates a narrow mechanism, not real-world recall.
No browser, live provider, full-suite, or production test is claimed.

Unverified: which exact toilet-paper/Bounty records the live picker contains,
profile coverage/version distribution, the wording and scope of the saved citrus
correction, and the precise Review picks recurrence path. Inspect these read-only
during the first implementation ticket; do not assume a missing product is OCR.

## What research suggests—and what we will not copy

- Amazon's [ESCI shopping-query benchmark](https://www.amazon.science/code-and-datasets/shopping-queries-dataset-a-large-scale-esci-benchmark-for-improving-product-search)
  distinguishes exact, substitute, complement and irrelevant query results.
  Adopt graded relevance rather than binary word equality. Its labels describe
  query relevance, not permission to merge two household catalog records.
- Google's [recommendation architecture](https://developers.google.com/machine-learning/recommendation/overview/types)
  separates candidate generation, scoring and re-ranking. Apply that separation;
  our small catalog does not need YouTube-scale retrieval infrastructure.
- Elastic's [hybrid search guidance](https://www.elastic.co/docs/solutions/search/hybrid-search)
  combines lexical and semantic retrieval. Evaluate this pattern without adopting
  Elasticsearch: precise SKU/brand evidence and semantic recall solve different
  needs. Rank fusion is a candidate, not a mandated algorithm.
- [Match, Compare, or Select? (COLING 2025)](https://aclanthology.org/2025.coling-main.8/)
  studies LLM matching with competing records. Test candidate-set selection rather
  than unrelated yes/no decisions for every pair. Its reported benchmark results
  do not establish accuracy for Costco receipts or household fulfillment.
- [Ditto](https://arxiv.org/abs/2004.00584) demonstrates learned entity matching
  with pretrained language models. Fine-tuning is a later option if we accumulate
  sufficient labels and inference volume; it is not the first investment here.
- Gemini's [structured-output guidance](https://ai.google.dev/gemini-api/docs/structured-output)
  requires application validation even for valid JSON. A schema or a model's
  self-reported confidence cannot prove a correct SKU or safe auto-match.

These sources support the design patterns; the phased choices and budgets below
are BasketSense proposals, not externally validated performance claims.

## Shared knowledge, three decision policies

Maintain a versioned, household-scoped product profile over the existing D1
catalog and understanding tables. Preserve original receipt text and product IDs.
Distinguish observed facts, household confirmations and model-generated proposals.

The profile should represent:

- Catalog identity: product ID, observed retailer/SKU, exact aliases, original labels.
- Meaning: readable name, brand, specific product type, broader family, meaningful
  variant, and pack/unit attributes only when evidenced; unknown stays unknown.
- Shopping intent: family phrases and household terms which the product may fulfill.
- Provenance: source, evidence reference, version, validation state and timestamps.
- Separate household relations: intent → product, relation, constraints, scope,
  revocation/supersession and revision. Never silently broaden an old correction.

One derived profile/search representation feeds three consumers, each with its
own contract. Adding a separate graph database is not required.

| Consumer | Question | Safe behavior |
| --- | --- | --- |
| Search | What might the user mean? | Broad retrieval; show candidates and let the user choose. A result is not identity confirmation. |
| Receipt matching | Did this purchase satisfy this saved request? | Prefer confirmed facts, respect variants and negative feedback, abstain when ambiguous. |
| Recommendations | Is this household likely to want this need again now? | Use purchase timing and explicit outcomes; never infer pantry stock or automatically add an uncertain suggestion. |

Illustrative acceptance examples—not an export of live catalog records:

- “toilet paper” should find toilet tissue; “Bounty” should retrieve relevant
  Bounty products when present. “paper towel” should not become toilet paper.
- “towel” is ambiguous: show paper and bath-towel candidates when present, not a
  confident silent attachment. Rank relevant previously purchased products first.
- “oranges” may be fulfilled by mandarins for this household. Preserve distinct
  SKU history; do not infer that grapefruit, juice or orange-flavored candy fits.
- An explicit navel-orange request remains more restrictive than “oranges.”
- “Downy Fresh”, “ZIPLC SLIDER”, “Naked White” and distinct Suja variants remain
  regression cases, alongside unseen products and deliberate non-matches.

### Where an LLM earns its cost

Use the existing Gemini integration to propose missing structured descriptions in
bounded, resumable batches, including historical catalog gaps. Cache by evidence
fingerprint and profile/prompt version; do not regenerate on each List read.
If a SKU cannot be grounded in provided evidence, mark it uncertain rather than
treating model familiarity as verification. Optional future public product lookup
requires a separate privacy review; no household receipt/query goes to web search.

Search starts with enriched lexical/type/alias retrieval. Compare an embedding
retriever as an additional candidate source only after measuring the remaining
misses. Cache profile vectors and query results; never send every keystroke to an
LLM. Benchmark candidate recall before blaming the re-ranker.

For unresolved receipt relationships, supply a bounded set of candidate IDs and
minimal product/intent descriptions to an optional semantic selector. Require
`same_product`, `fulfills_intent`, `substitute`, `not_same`, or abstain; validate IDs,
constraints and provenance server-side. No receipt images, amounts, member details
or full household history are needed for this stage. Treat all input text as data,
not instructions. Expanded use of typed household intent in provider requests must
be documented and approved before enabling it; today's enrichment sends labels.

Model proposals begin review-only. Negative household feedback takes precedence;
exact trusted facts remain deterministic. Calibrate any future automatic policy
on held-out labels, not generated confidence numbers. A model outage must leave
search, manual add, receipt totals and manual corrections working.

### Matching and correction semantics

Preserve the current four relations and useful post-trip questions. Show plain
language such as “This covered oranges” versus “Same exact product.” Default a
generic request to fulfillment, not catalog identity. Offer “Just this trip” and
“Remember for future trips” only where scope is genuinely ambiguous.

Use latest non-revoked confirmed evidence consistently across search, matching
and recommendation features. Invalidate derived caches when feedback changes.
Do not assume citrus fulfillment is symmetric or transitive. An exact named
variant or explicit not-same decision overrides a broad family candidate.

Evaluate matching over the whole trip. Lock authoritative links, then compare
greedy versus maximum-weight assignment on ambiguous remaining candidates. Keep
abstention; quantity is not identity evidence. Define grouping for repeated receipt
lines, split purchases and quantities so one paid line is never double-counted.
Do not ship a new assignment algorithm unless it improves the held-out cases.

### Recommendation evolution

Keep V2.1 as the comparator and fallback. First improve its inputs: consolidate
need-level timing only for defensible product groups or confirmed household
equivalences. A new pack/SKU must not reset all evidence for toilet tissue, but
paper towels and toilet tissue must never share replenishment cadence.

Score need and chosen SKU separately: “paper towels may be due” followed by the
household's supported brand/pack choice. Keep exact SKU prices independent; do
not average incomparable packs. Label estimates rather than inventing precision.

Continue simple, explainable timing models initially. Compare median-interval
V2.1 with a bounded probabilistic due window only if replay shows benefit.
Separate signals for “not needed this week”, “have enough”, “not for us”,
“removed duplicate” and unknown; a removed List row is not automatically dislike.
Vacation weeks are not missed purchases. Missing receipts are unknown. Returns
do not teach positive purchase cadence; standalone one-offs do not become weekly
essentials. Apply active-list deduplication and family diversity at re-ranking.

Do not fill every available slot merely to meet six suggestions. Showing fewer
useful items is success. Preserve explicit pause/retire and no automatic inclusion
of non-essential ideas. LLMs describe products; they do not invent need or stock.

## Checkpointed implementation order

Each ticket ends with a scoped diff, evidence report and rollback switch. Only
one major implementation ticket runs at once. Release approval remains separate.

| Ticket | Deliverable / likely files | Exit gate |
| --- | --- | --- |
| PI-0 | Retire Review picks mount, component-only code/styles/tests; `app/saturday-prep.tsx`, dashboard and relevant CSS/render tests | No wizard/banner on any surface; inline Ideas, Product Memory and post-trip questions unchanged. No data deletion or migration. |
| PI-1 | Shared catalog search contract and baseline fixtures; dashboard picker/Products, household product projection, new pure retrieval module/tests | Both search surfaces use available profile fields and aliases. Explicit selection uses product ID; broad manual labels remain intent. Current reported examples retrieved when evidence is supplied; record missing-profile failures separately. |
| PI-2 | Versioned profile coverage/backfill and invalidation; understanding worker module, contract, scoped API/schema only if needed | Entire eligible catalog accounted for as ready/uncertain/missing/error. Resumable idempotent batches; no financial/list mutation. Old profile remains usable until replacement validated. |
| PI-3 | Semantic retrieval experiment behind a switch; compare enriched lexical vs hybrid on same frozen corpus | Adopt embeddings only if held-out recall gains justify latency and cost. Keep lexical fallback and cross-surface parity. No vector service migration by default. |
| PI-4 | Intent selector, durable scope/revocation and whole-trip matching evaluation; receipt logic, review API/client and tests | Improved coverage at precision gate, zero forbidden merges, corrections survive reload/two members and don't recur. Ambiguous cases remain reviewable. |
| PI-5 | Need-level recommendation candidate features and re-ranking; V2 module, input builder, cutoff-safe replay | Beats current V2.1 or reduces suggestion burden at comparable recall; no leakage, forbidden auto-adds or suppression violations. |
| PI-6 | One invisible full-cycle comparison then limited visible rollout | Household reviews differences; switches for search/matching/recommendations independent. Observe two actual shopping cycles before calling the redesign successful. |

Recommended first engineering ticket: **PI-1, make product knowledge available
to both catalog search surfaces**, after a small PI-0 retirement. This addresses
the confirmed user-facing gap and creates the retrieval contract needed later;
do not start by increasing fuzzy thresholds or rewriting the recommender.

## Evaluation and explicit budgets

Establish baseline before changing policies. Start with at least 60 human-labeled
queries and 100 intent/receipt pairs across at least 20 product families, including
hard negatives, ambiguous brands, spelling errors, unseen abbreviations, explicit
variants and multiple competing lines. Synthetic cases cover edge conditions;
private owner-authorized cases evaluate real use without committing receipts.

Hold out entire product families and later trips, not random variants of the same
example. Separate development and final evaluation sets. Human labels define
ground truth; model-generated test labels cannot grade that same model. Report
exact counts and uncertainty alongside percentages: a small sample cannot prove
99% general precision. Accumulate at least 200 evaluated automatic decisions
before claiming even a preliminary precision estimate at that threshold.

Proposed release targets, to be ratified against baseline:

- Search: relevant candidate recall@5 ≥95% on in-catalog queries, with separate
  brand, generic, typo and unknown-query slices. All named regressions pass.
  Track ranking and unknown false positives, not only non-empty results.
- Matching: ≥99% observed precision for the auto-match bucket, ≥90% correct
  match coverage on held-out resolvable cases; zero prohibited variant/negative
  conflicts in the safety suite. If precision lacks enough evidence, keep the
  new model bucket review-only. Report recall and abstention independently.
- Corrections: every explicit remembered relation applies after reload and on
  the other member's next synchronized read; revocation removes it. No repeated
  question for the same resolved pair under unchanged evidence.
- Recommendation replay: precision@K, recall of recurring needs, family coverage,
  duplicate suggestion rate and suggestions per week against V2.1. Compare at
  equal K and with variable-length lists. Initial goal: ≥10% relative improvement
  in labeled usefulness or ≥25% fewer irrelevant suggestions without material
  recall loss; reject wins that only reduce coverage to easy essentials.
- Real experience: target ≥50% reduction in manual matching corrections on
  comparable trips; record both counts and minutes. Two cycles give directional
  evidence, not statistical proof. Do not call every later purchase a good suggestion.
- Performance: local enriched search computation p95 ≤50 ms; input-to-results
  p95 ≤200 ms on representative phones. An optional semantic request has an
  ≤800 ms timeout and never blocks manual Add. No generative call per keystroke,
  on core bootstrap, or five-second poll. Separate parsing and matching timing.
- Provider usage: default cap of one bounded semantic batch per receipt and one
  transient retry; unchanged evidence reuses cached results. Prototype profile
  backfill in 20-product batches. Propose a US$1 backfill / US$1 monthly household
  incremental inference cap before live activation; verify current provider prices
  and token limits then. These are design caps, not estimated bills.

Backtests must reconstruct what was known at each cutoff: purchases, profiles,
feedback, corrections and product states. Replaying today’s fully enriched catalog
against old receipts is a separate retrospective repair test, not a leakage-safe
recommendation forecast. Account for skipped weeks and unobserved shopping periods.

## Safety, surfaces, rollout and rollback

- All enrichment, search caches, feedback and evaluation artifacts remain household
  scoped and isolated from the owner sandbox. No private data in public source,
  browser bundles, logs, analytics or external research queries.
- Keep financial arithmetic, receipt finalization, discounts, original intent,
  historical revision evidence and price-estimate safeguards unchanged.
- First validate APIs/pure logic plus rendered UI in the owner sandbox. Cover
  320/390/430 px, landscape, 720 px and desktop, Warm/Light/Dark/Auto, keyboard
  navigation, VoiceOver labels, touch targets, reduced motion and no overflow.
- Exercise slow/offline/provider-failure states, stale responses, two-member
  corrections, cache revision changes, duplicate uploads, historical replacement,
  multiple matching candidates and exact-versus-family conflicts.
- Test raw photo/PDF → extraction → profile → matching → correction → next-trip
  reuse separately from parsed-text fixtures. A physical iPhone camera and Safari
  keyboard smoke remain explicit user-assisted checks, not viewport claims.
- Shadow code cannot write List rows, final matches or recommendation learning.
  Persist versioned diagnostics separately; no silent historical relabeling.
- Roll back each consumer independently to its previous policy. Preserve additive
  profile/feedback records; don't delete them. New automatic decisions need a
  versioned audit trail and explicit correction path because rolling back code
  cannot undo already confirmed household decisions.
- Deploy only after explicit approval and verified current Site identity/access/
  bindings. No new database, bucket, external search service or separate Worker
  deployment is implied by this plan.

## Next-session starting prompt

Read README.md, PRODUCT.md, docs/assistant-handoff.md and
docs/backlog/product-intelligence-roadmap.md. Work on BasketSense only and use
the current codebase graph first. Implement PI-0 and PI-1 in separate checkpoints:
retire only Saturday Prep / Review picks, then expose existing product knowledge
through one tested search policy used by List and Products. Preserve post-trip
questions, household feedback, financial evidence and the existing deployment.
Validate mobile/desktop/all themes and show measured search regressions before
and after. Do not start embeddings, backfill live data, commit or deploy without
the relevant approval. Read-only diagnosis must distinguish missing product data
from missing semantic coverage and ranking failures.
