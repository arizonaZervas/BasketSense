# Completed foundation: reconciled D1 dashboard cutover

**Status:** Validated

## Outcome

Every finalized, reconciled receipt can update historical products,
transactions, category totals, monthly spending, and dashboard drill-downs
through D1-backed household state.

## Evidence retained

- D1 is the canonical hydrated runtime source for dashboard history.
- The audited January–July 2026 view remains an independent parity fixture.
- An integration test requires the D1-derived view to match that fixture before
  the hydrated client view is used.
- A reconciled receipt updates the database-backed dashboard after the normal
  household refresh.
- Canonical product/category corrections flow into product and category views.

## Accounting rules carried forward

- Use `household_funded_cents` for household out-of-pocket spending and show
  external funding separately.
- Do not combine fuel, warehouse, optical, and returns without explicit labels.
- Category totals are line-item metrics; receipt tax and funding splits must
  remain explicit rather than silently allocated.
- Only reconciled receipts power exact actual-spend metrics. Draft, rejected,
  or uncertain records remain visible as data-quality work.

## Why this matters to the backlog

This parity pattern is the required migration model for BS-004 and BS-005:
build the replacement beside the trusted path, compare exact outputs, retain a
rollback route, and cut over only after the evidence matches.

