# BasketSense product backlog

This is a prioritized learning and product backlog, not a feature wish list. A task belongs here only if it improves a household decision, makes the data more trustworthy, or unlocks a meaningful next learning step.

## Completed: make reconciled D1 data power the dashboard

### Outcome

Every finalized receipt updates the historical product, transaction, category, monthly-spend, and insight views automatically.

### Why it matters

The shared list and receipt closed loop are live in D1. Historical dashboard views now hydrate from reconciled D1 receipt and product rows, so a finalized receipt becomes part of the next shared dashboard refresh. The audited TypeScript history remains a parity fixture for the established January–July 2026 baseline.

### Definition of done

- D1 is the canonical hydrated runtime source for dashboard transactions, product histories, monthly totals, category totals, and drill-downs.
- The audited January–July results remain a fixed parity fixture.
- An integration test requires a database-derived view to exactly match the audited fixture before client cutover.
- A finalized reconciled receipt updates dashboard data after the normal household refresh.
- Product/category corrections update category and product drill-downs using canonical product records.

### Implementation slices

1. Added read-only D1 query functions that return the typed dashboard view model.
2. Added an audited January–July parity test through the real household API and in-memory D1-compatible database.
3. Cut the hydrated dashboard over to D1 for transactions, product histories, categories, months, channels, and drill-downs.
4. Kept the audited server-rendered dataset as a visually equivalent first-paint fallback and test oracle.

### Important accounting rules

- Use `household_funded_cents` for household out-of-pocket spending; show `external_funding_cents` separately.
- Do not roll fuel, warehouse, optical, and returns into the same product-category metric without explicit labeling.
- Product category totals are line-item metrics. Receipt-level tax and funding splits must remain explicit rather than silently allocated to products.
- Only reconciled receipts should power “exact” actual-spend metrics. Draft or rejected receipts should be visible as pending data quality, not included silently.

## Next: recommendation engine v2

### Product decision

Build an explainable, household-specific recommendation engine that scores eligible products every week. Do not build a generic AI shopper, an automatic cart, or a black-box model.

The current fixed strategy is a useful first policy: it has clear hand-authored roles and explains itself. Its limitation is eligibility—only products deliberately included in the policy are considered. Engine v2 should make the *candidate set* data-driven while keeping household controls and explanations first-class.

### What a recommendation should mean

It should answer one narrow question:

> Given only what the household knew before this trip, is this product likely worth putting in front of them now?

It must not claim that a household needs an item, has run out, or will regret declining it. Purchase history indicates replenishment timing, not consumption or pantry inventory.

### Recommendation states

Give every product a household-controlled state. This is more useful than attempting to infer everything from receipts.

| State | Behavior |
| --- | --- |
| Essential | May enter the active list automatically only at high confidence; household can pause it. |
| Normal | Eligible for a one-tap suggestion when due. |
| Check first | Eligible, but never auto-added; ask whether the household already has enough. |
| Seasonal | Eligible only during an explicitly selected season/window. |
| One-off | Never predict from cadence alone. |
| Paused / retired | Hidden until manually restored. |

### Signals worth using

Start with signals that are observable, explainable, and stable with a small household dataset:

| Signal | What it can tell us | Limitation |
| --- | --- | --- |
| Purchase count | Whether there is enough history to model cadence | A repeated purchase can still be occasional. |
| Median purchase interval | Typical time between purchases | Does not prove consumption or inventory. |
| Interval variation | Whether timing is regular enough to trust | Few observations make this noisy. |
| Days since last purchase | Whether the product is approaching its usual window | A vacation or stock-up can distort it. |
| Typical quantity | Whether the household normally buys one or several | Quantity is not remaining stock. |
| Recent purchase streak | Whether the behavior is currently active | A short streak may be temporary. |
| List acceptance/removal | Whether suggestions are useful in the moment | A removal can mean “already have it,” not dislike. |
| Frozen-list vs receipt result | Whether included items were bought, missed, or substituted | Missing is not necessarily a recommendation error. |
| Explicit feedback | Duplicate, waste, regret, satisfaction, pantry check | Sparse but high-quality; never infer it silently. |
| Season/window setting | Whether a household wants an item considered at a time of year | Start explicit; one year's data is weak seasonality evidence. |
| Product price history | Estimate likely bill and flag changes | Price prediction is separate from replenishment prediction. |

### Deliberately separate two predictions

Do not use one confidence score for two different questions:

1. **Should we suggest this product?** A replenishment/intent score.
2. **What will it cost?** A price-estimate confidence and amount.

An item can be highly likely to be useful but have a volatile price. Conversely, a stable price does not make it timely.

### Version 2 scoring: simple, explainable, conservative

For a product with sufficient history, calculate a due score using the date before the target Saturday:

```text
cadence_due = days_since_last_purchase / median_purchase_interval
regularity = 1 - normalized_interval_variation
history_strength = grows with repeated, recent purchases
acceptance = recent accepts minus recent skips/removals
feedback_adjustment = explicit duplicate/waste/regret/satisfaction signals
override = household state and pause/season rules

recommendation_score =
  cadence_due + regularity + history_strength + acceptance
  + feedback_adjustment + override
```

The real implementation should use named, bounded components and a versioned scoring configuration rather than this unbounded pseudo-formula. Every score needs a reason string built from its strongest evidence.

Suggested routing:

| Score / condition | Presentation |
| --- | --- |
| Essential and very high confidence | Add to active list; easy to remove. |
| High confidence | “Recommended” with one-tap add. |
| Medium confidence or uncertain pantry state | “Check first.” |
| Explicit seasonal window and enough history | “Seasonal” suggestion. |
| Low confidence, sparse history, one-off, paused | Do not show. |

Set a strict attention budget: for example, no more than 6–10 visible non-essential suggestions. More suggestions reduce trust and encourage habitual dismissal.

### Data changes needed before engine v2

The existing `products`, `trip_list_items`, frozen intent, receipt matches, and `feedback` tables are a good foundation. Add only the durable signals that cannot be derived:

- a per-product household preference/state (`essential`, `normal`, `check_first`, `seasonal`, `one_off`, `paused`);
- optional seasonal windows and a manual “resume after” date;
- recommendation exposures: which version suggested what, on which trip, with which score/reason;
- the household response: accepted, removed before freeze, retained at freeze, checked, missing, substituted, or dismissed;
- a reason code when it is useful and low-friction, such as “already have enough,” “not this week,” or “do not suggest again.”

Avoid recording every hover/tap. Store decisions that can change future behavior.

### Evaluate before changing the live list

Backtest each historical Saturday as if the engine did not know the future:

1. Cut purchase history at the Friday before a past trip.
2. Generate only the recommendations the engine could have known then.
3. Compare them with the next reconciled warehouse receipt and recorded intent where available.
4. Repeat over every eligible week.

Track:

| Metric | Why it matters |
| --- | --- |
| Precision at K | Of the top K suggestions, how many were later purchased? |
| Coverage | How much of recurring purchasing does the engine surface? |
| False-positive burden | How many shown suggestions were declined, removed, or never bought? |
| Acceptance rate | Do both spouses add suggestions to the active list? |
| Freeze retention | Were accepted suggestions still intended at shopping start? |
| Fulfillment rate | Were frozen recommendations actually purchased or validly substituted? |
| Duplicate/waste/regret feedback | Does the engine reduce negative outcomes without measuring “impulse” from receipts? |
| Planning effort and enjoyment | Does the ritual stay easier and enjoyable? |

Receipt purchase is an imperfect label. A product may be useful but out of stock, purchased elsewhere, or deliberately postponed. Pair offline metrics with lightweight household feedback.

### Future models, only after enough data

With roughly one household and a few dozen weekly trips, a complex model will overfit. Consider these only after the rule-based engine has accumulated recommendation outcomes:

1. **Survival/hazard model:** estimates probability of a next purchase as time since last purchase grows. This is the most natural next statistical model for replenishment.
2. **Regularized logistic regression:** estimates purchase-within-the-next-trip from cadence, history, household preference, recent outcomes, and season flags. It remains explainable.
3. **Co-purchase associations:** proposes optional bundles only after repeated evidence, and only under “Consider.” Avoid auto-adding correlated products.
4. **LLM assistance:** summarize reasons, propose a human-review queue for ambiguous receipt descriptions, or turn a manual note into structured preference. It should not calculate totals, decide final classifications, or invent a recommendation without deterministic evidence.

### What not to build

- Pantry inventory inferred solely from receipt cadence.
- Automatic additions for discretionary, seasonal, or uncertain items.
- A single “impulse score” for purchases.
- Collaborative filtering from other households; the app is private and this household is unusual by definition.
- A black-box recommender trained on too little data.
- A recommendation feed that rewards attention instead of reducing decisions.

## Later: household data ownership and health

- Owner-only read-only data-health view: row counts, unreconciled receipts, unreviewed categories, and open questions.
- Versioned JSON/CSV export of household records.
- Explicit receipt-image retention and deletion controls.
- Production-safe backup and recovery runbook.

## Working rule for backlog decisions

Before starting an item, state:

1. the household behavior it should improve;
2. the evidence that would prove it worked;
3. the smallest reversible test;
4. the data it needs; and
5. what the system must not claim.

If we cannot answer those five points, it stays a product idea rather than becoming implementation work.
