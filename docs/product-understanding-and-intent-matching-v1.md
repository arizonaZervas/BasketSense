# Product Understanding and Intent Matching v1

**Status:** Released to the private BasketSense Site on 2026-08-23 in Sites
version 84. Migration 0014 completed through the existing app-owned migration
gate. The separate receipt Worker was not deployed.

## Outcome

BasketSense now separates three questions that were previously conflated:

1. What did the receipt visibly print?
2. What ordinary product does that abbreviation probably describe?
3. Did that product satisfy this household's saved intent?

The printed receipt line remains immutable evidence. Gemini may add advisory
product understanding after strict extraction, but it cannot change receipt
amounts, automatically decide a household match, add a List item, or make a
recommendation. Explicit household confirmations remain authoritative.

## Receipt understanding path

- Strict receipt extraction continues to preserve Costco's exact printed label.
- A second, text-only Gemini request receives only unique product item numbers
  and printed labels. It never receives the receipt image, totals, prices, List,
  trip comparison, or household recommendation state.
- The response is bounded to canonical name, brand, product family, variant,
  category hint, aliases, SKU certainty, and confidence.
- Item-number results are cached per household in D1. Raw-label results use a
  normalized description key. Current-version semantic understanding enriches
  an existing catalog SKU; the catalog remains the non-blocking fallback.
- Cache misses are batched into at most one optional request per receipt. There
  are no scheduled or weekly model calls.
- Provider failure is non-blocking. BasketSense saves the strict receipt draft
  and continues to review without semantic metadata.

High-confidence interpretations can give a newly finalized catalog product a
readable proposed name, brand, and category hint. The product still enters
category review, and the original receipt label remains unchanged. If the user
edits a draft's item number or description, BasketSense discards the hidden
interpretation before saving.

## Intent matching path

Migration 0014 adds `intent_fulfillments`, a household-scoped relation between
a normalized intent label and either a Costco item number or normalized receipt
description. Unlike `product_aliases`, it does not require either side to have
a catalog product ID.

When a household explicitly confirms that a receipt line fulfilled a saved
item, BasketSense records both the exact item-number key when available and the
normalized printed-label key. A later receipt can then reuse that confirmation
at high confidence. This closes the failure mode where `ZIPLC SLIDER` could be
manually matched to `Ziploc bags` once but the correction was forgotten because
neither side had a product ID.

Gemini-proposed canonical names are advisory matching candidates capped below
the automatic-match threshold. Automatic matches still require exact receipt
evidence, an existing catalog/alias relationship, or an explicit household
fulfillment confirmation.

## Data changes

Migration [`0014_dusty_sprite.sql`](../drizzle/0014_dusty_sprite.sql) adds:

- `product_understandings`, including provider/model/prompt/schema provenance;
- `intent_fulfillments`, including the confirming member and relation; and
- nullable interpretation columns on `receipt_items`.

The app-owned runtime migration applies the same changes idempotently to the
private Sites D1 binding. No new D1, R2, Worker, model secret, or access rule is
required.

## Validation

- BasketSense production build passes.
- BasketSense-only TypeScript validation passes.
- Receipt Worker staging dry-run bundles successfully with existing bindings.
- Focused product-understanding, ingestion, review, matcher, migration, and
  household API tests pass.
- The complete BasketSense test set passes without running Good Cart Day tests.

## Release and observation gates

Before release, verify the existing private site, exact two-member allowlist,
current rollback version, Gemini secret presence, and D1/R2 bindings. Apply the
app and migration together. The separate receipt Worker remains an independent
release decision.

After release, use the owner sandbox to test:

1. a known catalog receipt line (no new Gemini understanding call expected);
2. an unknown abbreviation (receipt review must succeed even if understanding
   is unavailable);
3. an explicit list-to-receipt correction with no product ID; and
4. a later receipt using that same item number or abbreviation.

No production receipt contents should be logged or copied into test evidence.

## Deferred recommendation work

Recommendation Engine v2 remains a separate leakage-safe backtest and shadow
ticket. Product family and explicit fulfillment evidence may become bounded
features in that evaluation, but no LLM output may directly rank, auto-add, or
suppress a Saturday recommendation.

## Household Intent Matching revision — 2026-08-23

The revision was released in private Sites version 85 from commit
`090e562e2885c3562d90142ed9c83c8766c324fc`.
Review questions now preserve one of four household decisions:

- `same_product` teaches catalog identity and the receipt/list wording pair;
- `fulfills_intent` confirms the need was satisfied without merging products;
- `substitute` confirms a deliberately different replacement;
- `not_same` permanently suppresses that intent/receipt pair.

All four decisions are stored in `intent_fulfillments`. Only
`same_product` may update product aliases or receipt product identity. The
other relations affect matching only, preventing a substitution from silently
collapsing two catalog products.

Local receipt-style simulations cover compact labels such as organic milk,
coconut water, storage bags, and cupcakes without retaining the private source
image or its metadata in the repository.

## Product Intent Resolution v2 — release candidate, 2026-08-30

This revision is implemented and validated for the next private BasketSense
release. Migration 0017 is additive; the application can be rolled back while
leaving its columns and seed rows in place.

The v2 contract separates exact-product `searchAliases` from broader
`intentAliases`. A typed exact-product phrase can attach durable catalog
identity and price history; a family request such as `bread` remains an intent
and can be fulfilled by a trusted receipt interpretation without permanently
binding the List item to one bread SKU.

The receipt reader now refreshes stale v1 understanding even when the Costco
SKU already exists in the catalog. Previously the catalog fallback incorrectly
made those lines look resolved and skipped semantic enrichment. Only current
prompt/schema versions participate in automatic matching or list resolution.

Migration 0017 adds `intent_aliases_json` and seeds two verified household
corrections as durable data:

- `5161251`: Downy Unstopables Fresh / Downy Fresh / laundry scent-booster
  beads;
- `1860779`: Naked White bread / white bread / bread.

Those examples are regression fixtures, not the matching strategy. The general
path is versioned Gemini understanding, unique exact-product resolution,
explicit intent fulfillment, and permanent household feedback. Low-confidence,
variant-conflicting, or competing matches remain review candidates.

Completed Recaps also re-evaluate automatic matches against the current
versioned understanding. A newly confident match is projected into the read
model and removes an obsolete open intent question, but opening Recap never
writes `trip_item_matches`; persisted system matches and spouse decisions stay
authoritative.

Validation covers the two live examples, unseen dishwasher-tabs wording,
generic-family ambiguity, variant ambiguity, stale-cache refresh, list-add API
resolution, read-only historical Recap self-healing, D1 migration idempotency,
the production BasketSense build, and all 198 BasketSense-only tests.
