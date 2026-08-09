# BasketSense performance audit handoff

Date: 2026-08-08

Scope: private BasketSense only. Good Cart Day is explicitly out of scope.

## Current status

- A three-part Sol Ultra read-only audit covered the React client, polling, household/D1 API, receipt ingestion Worker, R2, and Workflow architecture.
- Chrome DevTools MCP is installed globally as `chrome-devtools`, but the task that installed it could not hot-load it. A fresh task must run the live trace.
- The customer-facing Data Health tab and its client component were removed. The owner-authorized `view=data-health` and export backend paths remain dormant for future debugging and data export.
- No performance refactor from the audit has been implemented yet.

## Ranked opportunities

1. Remove request-time schema probes, DDL, household seeding, recommendation seeding, and per-request member writes. The current fixture executes roughly 40 SQL statements for a full household GET; receipt-ingestion status polling executes nine DDL statements plus its authorization query.
2. Replace fixed full-snapshot polling and mutation-triggered full reloads with revision/ETag-based synchronization, authoritative mutation deltas, and lightweight list reconciliation. Durable Object WebSockets are optional only after the simpler contract is measured.
3. Split the monolithic household/dashboard read model. The local initial dashboard representation measured 416,813 raw JSON bytes, and the client immediately requests another full snapshot. Lazy-load tab-specific data, paginate history, and pre-aggregate finalized receipt analytics.
4. Make receipt OCR asynchronous. Upload to R2, insert an idempotent job/outbox record, dispatch the existing Workflow privately, and return `202 queued` before Gemini runs. Add stale-dispatch recovery and stop terminal/draft-triggered polling.
5. Window the Products list and serve image variants. Build lookup maps instead of nested row-level `.find()` calls, mount roughly 30–40 rows, and use 64/128px thumbnails while reserving full resolution for the image viewer.

## Required correctness companion

Receipt finalization is currently a non-atomic sequence of updates, deletes, inserts, and rereads. Add receipt revisions/CAS plus a staged item generation that is atomically activated before completing the trip. Test concurrent edit/finalize and failure injection through the 200-line maximum.

## Verification baseline for the next task

Before changing architecture:

1. Read `README.md`, `PRODUCT.md`, `docs/assistant-handoff.md`, and this file.
2. Query the `basketsense-2` codebase-memory graph first. Reindex if its working-tree hash is stale.
3. Use the freshly available Chrome DevTools MCP against the authenticated private site. Record LCP, INP, CLS, initial document/JS/CSS/image bytes, `/api/household` frequency and payload size, D1-related request timing visible from the client, and a Products scroll interaction.
4. Add privacy-safe test instrumentation for SQL statement count, D1 call count, response bytes, and unchanged-state React commits. Do not inspect or report receipt contents or personal data.
5. Turn the ranked list into separate, checkpointed implementation tasks. Terra owns contracts, migrations, and concurrency-sensitive changes; Luna owns instrumentation, mechanical client changes, image variants, and regression tests. Use Sol only for a final independent risk review.

## Acceptance budgets to establish

- Steady-state list refresh: at most two SELECTs, zero writes, zero DDL.
- Ten rapid check-offs: ten mutations, zero full household GETs, and at most one lightweight reconciliation.
- An unchanged sync response causes no active-list or Products row commits.
- Initial List load contains one dashboard/list representation, not a static dashboard plus an immediate duplicate full snapshot.
- Receipt upload returns before Gemini processing and survives browser closure or refresh.
- Products mounts a bounded window and thumbnail responses stay within an explicit pixel/byte budget.

Do not deploy architectural changes until tests, authenticated browser verification, and BasketSense/Good Cart Day isolation checks pass.
