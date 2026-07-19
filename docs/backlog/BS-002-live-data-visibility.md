# BS-002 — Live data visibility and ownership

**Status:** In progress  
**Priority:** 2  
**Decision gate:** Supports Gates A and B

## Outcome

The household owner can understand the actual hosted data powering BasketSense,
export it, and identify data-quality work without receiving write-capable SQL
access inside the product.

## Rationale

The local SQLite lab is useful for learning but it is not the hosted D1
database. A controlled production view improves trust now and later becomes the
minimum support and operations surface for multiple households.

## Dependencies

- Existing household authorization and owner role remain trustworthy.
- Metric definitions continue to distinguish household funding, external
  funding, channels, tax, discounts, and reconciliation status.
- Production infrastructure ownership and remote Wrangler access remain part
  of BS-004, not a prerequisite for the first read-only view.

## Smallest test

Expose one owner-only data-health view with household-scoped counts for
receipts, receipt lines, products needing review, unreconciled receipts, and
open review questions. Compare those results with the existing dashboard and a
read-only local query fixture.

## Intended scope

- Hosted row counts and recent records by safe, predefined view.
- Receipt reconciliation and unresolved-line queues.
- Product/category review queue.
- Links into existing receipt and product drill-downs.
- Paginated household JSON and CSV export with schema/version metadata.
- A one-command local read-only SQLite launcher for the learning lab.
- Explicit timestamps and scope labels so local, fixture, and hosted data are
  never confused.

## Acceptance criteria

- Only an authenticated owner can access the explorer or export.
- Every query is server-scoped to the resolved household.
- Explorer totals reconcile with the same source rows as the dashboard.
- Large views are paginated and do not silently truncate.
- Export contains one household and is reproducible from documented fields.
- No endpoint accepts arbitrary SQL or mutation statements.
- Access attempts by a member of another household return no resource details.

## Privacy risks

An explorer concentrates sensitive data. It must use private/no-store responses,
avoid raw receipt text in logs, prevent spreadsheet-formula injection in CSV,
and never expose member emails or storage keys unnecessarily.

## Explicit non-goals

- A general-purpose production SQL console.
- Editing D1 rows outside application rules.
- Migrating databases solely to obtain a browser UI.

## Evidence after completion

Pending. Retain authorization-test results, dashboard/export reconciliation,
and one successful owner learning session.

## Current implementation slice

The owner-only hosted D1 Data Health & Explorer is being released first. It
shows predefined, household-scoped counts and queues; filters receipt, trip,
product, and recommendation-list records; exposes JSON and receipt-ledger CSV
exports; and rejects member access server-side. The view intentionally excludes
receipt images, R2 storage keys, arbitrary SQL, and write controls. Batch import
job telemetry, pagination beyond the initial safe record cap, drill-through
links, and the local read-only database launcher remain open work for BS-002.
