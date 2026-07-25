# BS-004B — Family migration and production cutover

**Status:** Blocked by Gate A  
**Priority:** 5  
**Decision gate:** Gate B

## Outcome

The current BasketSense family deployment moves to the tenant-aware product
path only after synthetic staging, export/restore, shadow parity, and rollback
evidence protect the established weekly loop.

## Rationale

Public marketing is safely decoupled from the family migration. The family app
must not become a test subject for multi-tenancy, auth, or schema work.

## Dependencies

- Gate A passes.
- BS-004A public boundary proof is complete.
- Versioned migrations, a tenant repository, export/restore rehearsal, and
  exact dashboard/list/receipt/feedback parity are available.

## Smallest test

Restore a synthetic family-shaped backup into staging, run the tenant-aware path
in shadow, compare all user-visible values, then roll back without altering the
private production deployment.

## Acceptance criteria

- Family dashboard, products, lists, receipts, feedback, and exports match.
- Rollback is rehearsed and bounded.
- No dual-write remains after an approved cutover.
- Private family deployment stays usable throughout validation.

## Privacy risks

Migration fixtures, exports, logs, and staging data can reproduce the family’s
purchase history. Use synthetic fixtures by default and tightly control any
temporary production-shaped copy.

## Evidence after completion

Pending.
