---
target: BasketSense dashboard
total_score: 22
p0_count: 0
p1_count: 3
timestamp: 2026-07-15T13-59-11Z
slug: app-basket-sense-dashboard-tsx
---
⚠️ DEGRADED: single-context (Assessment A sub-agents did not complete; the parent completed A before reading the isolated Assessment B report)

# BasketSense dashboard design critique

## Design Health Score

| # | Heuristic | Score | Key issue |
|---|---|---:|---|
| 1 | Visibility of System Status | 2/4 | Active navigation, data labels, and toasts exist, but “saved/versioned/shared” status is not truthful for session-only state. |
| 2 | Match System / Real World | 3/4 | Essentials, Check first, Consider, and nonjudgmental copy fit household shopping; the overview-first model does not match the Saturday job. |
| 3 | User Control and Freedom | 2/4 | Add/remove, modal cancel, and copy are clear; review answers lack Undo and several visible controls are inert. |
| 4 | Consistency and Standards | 2/4 | Components look consistent, but mobile removes receipt access and some controls change appearance without changing data. |
| 5 | Error Prevention | 2/4 | Input constraints and cautious receipt language help; list-state loss and mistaken review answers are not prevented. |
| 6 | Recognition Rather Than Recall | 3/4 | Reasons, sources, and labels stay visible; letter-glyph navigation and hidden mobile receipt capture reduce discoverability. |
| 7 | Flexibility and Efficiency | 2/4 | Quick add and copy help, but the primary list is the fourth destination and review has no batch/shortcut path. |
| 8 | Aesthetic and Minimalist Design | 2/4 | The hero is clear, but the overview has too many competing cards, decorative treatments, and micro-labels. |
| 9 | Error Recovery | 2/4 | Import and clipboard errors use plain language; there is no undo/restore for learning decisions or interrupted sessions. |
| 10 | Help and Documentation | 2/4 | Inline explanations and evidence labels are strong, but recommendation-rules help is inert and not progressively disclosed. |
| **Total** |  | **22/40** | **Acceptable — significant improvements needed** |

## Anti-Patterns Verdict

**LLM assessment:** Yes, the surface has a recognizable AI-dashboard layer even though the product thinking is better than average. The warm cream canvas, forest/apricot/lilac palette, many 22–24px rounded cards, wide soft shadows, repeated tiny uppercase eyebrows, letter tiles, and uniformly weighted widgets feel generated rather than earned. The household language and epistemic restraint keep it from feeling generic end-to-end.

**Deterministic scan:** The required TSX scan returned `[]` with exit code 0: zero findings, zero rules, zero locations. That clean result is narrowly accurate for the markup target, not proof that the composed surface is clean. Manual CSS evidence still shows border-plus-wide-shadow ghost cards, tracking below the -0.04em floor, and 16 eyebrow uses. The detector missed them because styling lives in `app/globals.css`, which the required command did not scan as a separate target. A repeating gradient on the chart would be a likely syntax-level false positive because grids are allowed on data surfaces; the actual design problem is that its lines have no labeled scale.

**Visual overlays:** None. Browser selection returned `No browser is available`, with availability `[]`; no tab, viewport, injection, console evidence, screenshot, or reliable user-visible overlay exists.

## Overall Impression

BasketSense already sounds like the right product: gentle, explainable, and household-first. It does not yet behave or look like the right product. The single biggest opportunity is to stop leading with a generic analytics dashboard and make the Saturday list the home experience. Everything else should support that ritual.

## Cognitive Load

High: 6 of 8 checks fail. Single focus fails because planning, review, spending, categories, and insights compete on Overview. Chunking fails because the first screen presents more than four distinct blocks. Grouping is adequate. Visual hierarchy is only partial because almost every block is a rounded card. One-thing-at-a-time fails on Overview and Review. Minimal choices fails at five global destinations and the six-option Snack assortment question. Working-memory burden is moderate because evidence often requires cross-tab context. Progressive disclosure fails because analytics, product history, and learning are all top-level from the start.

## Emotional Journey

The opening tone is reassuring, and the Saturday hero creates a good anticipatory peak. The valley arrives when the user must scan a dense dashboard to find the weekly task. The largest trust valley is false reassurance: “Automatically saved,” “automatically versioned,” “Saved just now,” and a shared link are claimed even though state lives only in React memory. Checking items is satisfying, but refresh or interruption can erase that success. The intended end state should celebrate readiness and a worthwhile discovery, not conclude on spending totals or fragile session state.

## What’s Working

1. **The language respects autonomy.** “Receipts suggest timing. You decide need,” “Unknown is a valid answer,” and separating returns from regret avoid guilt and false certainty.
2. **Evidence stays close to suggestions.** Purchase rhythm, last-purchased timing, raw receipt descriptions, and provenance badges make recommendations understandable.
3. **The accessibility foundation is better than the styling.** Visible focus styles, 44px primary controls, labeled check actions, an ARIA live region, modal labeling, and reduced-motion support are present.

## Priority Issues

### [P1] The primary Saturday job is demoted

**Why it matters:** The household opens BasketSense to prepare or use the list, yet the app defaults to a long analytics Overview and places This Week fourth in both navigation systems. That adds friction every week and encourages passive viewing over behavior change.

**Fix:** Make “This Saturday” the default home from Friday through the trip. Lead with quick add, the next three due items, one pantry check, and one prominent Open list action. Move Spending and Products under a secondary History/Insights area. Reduce mobile navigation to three or four destinations.

**Confidence:** High. **Cheapest test:** For two trips, default directly to This Week and time how long each spouse takes to make the first useful edit.

**Suggested command:** `$impeccable distill`

### [P1] The interface asserts persistence and collaboration that do not exist

**Why it matters:** “Automatically saved,” “automatically versioned,” “Saved just now,” and a shared link create confidence that session-only React state cannot honor. The period selector, See recommendation rules, and Pause suggestions also present incomplete affordances. This is a trust problem, not unfinished polish.

**Fix:** Until persistence exists, say “Prototype · changes last for this tab,” remove/disable inert controls, and make every filter visibly affect data. Once persistence exists, show last editor, real sync status, offline/error state, and recoverable history.

**Confidence:** High. **Cheapest test:** Replace the claims with truthful prototype copy and ask each spouse what they expect to survive after refresh.

**Suggested command:** `$impeccable harden`

### [P1] Mobile hides receipt capture entirely

**Why it matters:** Responsive CSS removes both the side rail and Add receipts button. That blocks the natural post-trip workflow on the device most likely to photograph a receipt.

**Fix:** Put a labeled receipt/camera action in the mobile header, bottom navigation, or a More sheet. Keep it in the thumb zone and return to a plain reconciliation status after file selection.

**Confidence:** High. **Cheapest test:** Add a nonfunctional capture affordance to a phone mockup and verify that both spouses can find it within five seconds.

**Suggested command:** `$impeccable adapt`

### [P2] The visual system makes every block look equally important

**Why it matters:** Warm cream surfaces, repeated shadows, oversized radii, nested cards, tiny uppercase eyebrows, letter tiles, and 8–11px labels create an AI-template feel and flatten hierarchy. Mobile readability suffers most.

**Fix:** Flatten most containers; reserve elevation for the modal and one Saturday focus surface; cap routine radii at 12–16px; use one neutral canvas and one accent; replace most eyebrows with sentence-case labels; adopt a fixed product type scale with 14–16px body and 12–13px secondary text; keep display tracking at or above -0.04em; replace letter tiles with conventional labeled icons. Give chart gridlines numeric meaning or remove them.

**Confidence:** High. **Cheapest test:** Restyle only Overview and This Week with no shadows, one card radius, and the larger type scale, then compare first-glance task identification at phone width.

**Suggested commands:** `$impeccable quieter`, then `$impeccable typeset`

### [P2] Review asks too much and records answers too abruptly

**Why it matters:** One card exposes six peer choices and resolves immediately. That exceeds the four-option cognitive-load guideline and makes a learning decision feel irreversible.

**Fix:** Show three likely answers plus More / not sure, process one question at a time, confirm the answer inline, and provide Undo. Prefer a compact inbox row before expanding the question.

**Confidence:** Medium. **Cheapest test:** Compare the six-button card with a three-plus-more paper prototype and count hesitation/mis-taps across the four sample questions.

**Suggested command:** `$impeccable clarify`

## Persona Red Flags

**Alex (Power User):** Five top-level destinations, no bulk review or shortcuts, inert controls, and fixed Overview scrolling slow a repeated weekly workflow.

**Sam (Accessibility-Dependent):** Many 8–11px labels and muted microcopy are fragile at zoom/low vision; the custom chart semantics and horizontal receipt table add navigation burden. Visible focus and reduced motion are positives.

**Casey (Distracted Mobile User):** Receipt capture is unreachable, This Week is fourth in a five-item bar with 8px labels, the long Overview delays the list, and an interruption/refresh loses progress.

## Minor Observations

- Hard-coded dates and “Good evening” can become obviously wrong.
- Spending and Products share category-filter state, so one tab can unexpectedly filter the other.
- The $30 Discovery room is encouraging only if the household chose it; otherwise it becomes another budget target.
- The monthly chart has no numeric axis or direct values, so comparison is approximate rather than actionable.
- The design is gentle but visually generic; personality should come from the Saturday ritual and household outcomes, not more decoration.

## Questions to Consider

- If BasketSense could surface only one thing on Saturday morning, should it be the ready-to-check list or a spending summary?
- Do two household members need five top-level destinations, or could Spending and Products become one History/Insights area?
- Is Discovery room genuinely liberating, or does a visible dollar amount turn permission into pressure?
- What should the user see when the other spouse changed the list and sync is delayed?

## Highest-Impact Order

1. Make This Saturday the product home.
2. Make all save, sync, sharing, and filter states truthful.
3. Restore mobile receipt capture.
4. Flatten the card-heavy visual system and enlarge type.
5. Simplify Review and add Undo.
