# BS-002 — Live data visibility and ownership

**Status:** Ready — re-scoped after removal of the customer-facing Data Health tab
**Priority:** 2  
**Decision gate:** Supports Gates A and B

## Outcome

The household owner can understand the actual hosted data powering BasketSense,
export it, and identify data-quality work without receiving write-capable SQL
access inside the product.

## Rationale

The local SQLite lab is useful for learning but it is not the hosted D1
database. Controlled owner-only inspection and export improve trust now and
later become the minimum support and operations surface for multiple
households. These capabilities do not belong in normal household navigation.

## Dependencies

- Existing household authorization and owner role remain trustworthy.
- Metric definitions continue to distinguish household funding, external
  funding, channels, tax, discounts, and reconciliation status.
- Production infrastructure ownership and remote Wrangler access remain part
  of BS-004, not a prerequisite for the first read-only view.

## Smallest test

Run one explicit owner-only data-health summary and household export with
counts for receipts, receipt lines, products needing review, unreconciled
receipts, and open review questions. Compare those results with the existing
dashboard and a read-only local query fixture without restoring a customer UI
tab.

## Intended scope

- Hosted row counts and recent records through safe, predefined owner actions.
- Receipt reconciliation and unresolved-line queues.
- Product/category review queue.
- Paginated household JSON and CSV export with schema/version metadata.
- A one-command local read-only SQLite launcher for the learning lab.
- Explicit timestamps and scope labels so local, fixture, and hosted data are
  never confused.

## Acceptance criteria

- Only an authenticated owner can access the inspection or export actions.
- Every query is server-scoped to the resolved household.
- Inspection totals reconcile with the same source rows as the dashboard.
- Large views are paginated and do not silently truncate.
- Export contains one household and is reproducible from documented fields.
- No endpoint accepts arbitrary SQL or mutation statements.
- Access attempts by a member of another household return no resource details.

## Privacy risks

Inspection and export concentrate sensitive data. They must use
private/no-store responses, avoid raw receipt text in logs, prevent
spreadsheet-formula injection in CSV, and never expose member emails or storage
keys unnecessarily.

## Explicit non-goals

- A general-purpose production SQL console.
- Editing D1 rows outside application rules.
- Migrating databases solely to obtain a browser UI.

## Evidence after completion

Pending. Retain authorization-test results, dashboard/export reconciliation,
and one successful owner learning session.

## Current implementation state

The customer-facing Data Health tab and `DataHealthExplorer` no longer exist in
the UI. Owner-authorized backend inspection and export paths remain available
as a dormant operational foundation. Before BS-002 is marked complete, recheck
their authorization and dashboard parity, finish paginated/versioned export,
and document one successful owner recovery or learning session. Do not restore
the removed tab merely to complete this ticket.
