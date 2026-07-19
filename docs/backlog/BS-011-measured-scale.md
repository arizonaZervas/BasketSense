# BS-011 — Scale based on measured usage

**Status:** Blocked by BS-010  
**Priority:** 11

## Outcome

BasketSense has evidence that its database, storage, synchronization, ingestion,
and operating model can support a Saturday-shaped workload for at least 100
households and 200 devices without weakening correctness or privacy.

## Rationale

The expected data volume is modest; concurrency, polling, expensive queries,
OCR work, and support operations are more likely bottlenecks. Optimization
should follow measured traces rather than speculative re-platforming.

## Dependencies

- BS-010 supplies real request patterns, correction behavior, and object sizes.
- Production metrics distinguish requests, D1 rows read/written, query latency,
  R2 storage/operations, ingestion work, and errors without logging private data.
- The shared-D1 beta topology remains the baseline unless evidence disproves it.

## Smallest test

Replay a synthetic Saturday workload shaped from friend-beta measurements for
100 households and 200 foreground devices. Include list edits, refreshes,
freezes, receipt uploads, dashboard reads, and retries while verifying tenant
isolation and exact totals.

## Acceptance criteria

- The workload model and assumptions are documented and reproducible.
- Latency, error rate, D1 rows read/written, request count, storage, and
  operation costs are reported by scenario.
- No cross-household data appears under concurrent load.
- Retries and concurrency do not duplicate list rows or receipt spending.
- Polling is optimized only where measured; background and hidden clients do
  not generate unnecessary full-state reads.
- Required indexes are justified by query plans and measured row scans.
- D1/R2/Workers plan limits and estimated beta operating cost are reviewed.
- Any topology or platform change returns to the backlog as an explicit
  decision rather than being embedded in a performance patch.

## Privacy risks

Load tests must use synthetic data. Production traces and metrics must exclude
receipt text, product histories, member emails, invitation tokens, and object
keys while still supporting operational diagnosis.

## Explicit non-goals

- Enrolling hundreds before the test.
- Premature per-household databases.
- Replacing polling, D1, or R2 without measured evidence.
- Optimizing vanity benchmarks unrelated to Saturday use.

## Evidence after completion

Pending. Attach the workload model, performance and cost report, isolation and
idempotency results, bottleneck list, and explicit wider-expansion decision.

