# BS-003 — Recommendation engine v2

**Status:** Proposed  
**Priority:** 3  
**Decision gate:** Gate A

## Outcome

Every eligible household product is evaluated by an explainable,
household-specific recommendation policy. The new policy proves its usefulness
in backtests and shadow runs before it changes the visible Saturday list.

## Rationale

The current fixed policy explains itself but considers only deliberately coded
products. Version 2 should make eligibility data-driven while preserving user
control and refusing to confuse purchase cadence with household inventory.

## Dependencies

- Reconciled product histories from the D1 dashboard foundation.
- BS-001 evidence about real accepts, removals, freeze retention, and feedback.
- Recommendation inputs must use only information available before the target
  trip; no future-data leakage.

## Smallest test

For each historical Saturday, cut the data off before that trip, generate the
top recommendations, and compare them with later intent and receipt outcomes.
Then run the candidate engine invisibly for one live Saturday and compare it
with the current policy.

## Product states

- Essential: eligible for automatic inclusion only at high confidence.
- Normal: eligible for a one-tap suggestion.
- Check first: shown as a pantry/freezer check, never auto-added.
- Seasonal: considered only inside an explicit window.
- One-off: never predicted from cadence alone.
- Paused or retired: hidden until restored.

## Explainable signals

- Purchase count and recency.
- Median interval and interval variation.
- Days since last purchase and typical quantity.
- Recent purchasing streak.
- Recommendation acceptance, removal, freeze retention, and fulfillment.
- Explicit duplicate, waste, regret, satisfaction, and pantry-check feedback.
- Household product state and season window.

Price-estimate confidence remains separate from recommendation confidence. A
stable price does not make an item timely, and a timely item can have a volatile
price.

## Acceptance criteria

- Every score is composed from named, bounded, versioned components.
- Every visible recommendation has a concise evidence-based reason.
- Backtests report precision at K, coverage, false-positive burden, and the
  limitations of receipt purchase as a label.
- Shadow results are compared with the current policy for at least one live
  cycle.
- Non-essential suggestions have a strict attention budget.
- Users can add, reject, pause, or reclassify every recommendation.
- No discretionary, seasonal, or uncertain item is silently auto-added.
- A Gate A review concludes that the engine reduces decisions rather than
  increasing noise before visible cutover is considered.

## Privacy risks

Recommendation outcomes reveal household habits. Store only decisions that can
improve future behavior; do not record every tap, hover, or cross-household
behavioral comparison.

## Explicit non-goals

- Pantry inventory inferred from receipts.
- A single impulse or regret score.
- Cross-household collaborative filtering.
- A black-box model or LLM deciding recommendations, totals, or accounting.

## Evidence after completion

Pending. Attach the leakage-safe backtest, live shadow comparison, explanation
examples, and Gate A decision.

