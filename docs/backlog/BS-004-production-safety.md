# BS-004 — Production safety and migration foundation

**Status:** Blocked by Gate A  
**Priority:** 4  
**Decision gate:** Gate B

## Outcome

BasketSense can evolve toward external households without exposing family data
or risking the trusted family product during infrastructure and schema changes.

## Rationale

The current private access boundary makes family-specific bootstrap and audited
history safe enough for two users, but those assumptions are unacceptable once
access widens. Migration safety and operational ownership must precede
multi-tenancy.

## Dependencies

- Gate A passes.
- The completed D1 dashboard parity fixture remains trustworthy.
- Hosting/authentication and migration ownership decisions are recorded under
  `decisions/` before implementation begins.

## Smallest test

Create a parallel environment containing only synthetic household data, render
a neutral authenticated first paint, apply versioned migrations, export and
restore the synthetic database, and prove the family production environment was
unchanged.

## Intended scope

- Remove audited family history from unauthenticated or generic production
  bundles; retain it as a private fixture and one-time legacy migration input.
- Replace fixed household bootstrap with an explicit legacy-family migration
  and later tenant-aware lifecycle.
- Establish one authoritative versioned migration path.
- Separate local, test, staging, and production bindings.
- Establish owner-controlled D1/R2 visibility, export, restore, and rollback.
- Run new paths in shadow before any family cutover.

## Acceptance criteria

- No family purchase data appears in unauthenticated HTML or JavaScript.
- A production-shaped migration rehearsal preserves all household invariants.
- Current dashboard, products, lists, receipts, and feedback pass exact parity.
- Export and restore are successfully rehearsed.
- Each cutover has a bounded rollback path and named decision owner.
- The existing family deployment remains usable throughout validation.
- Synthetic staging contains no production credentials or household data.

## Privacy risks

Fixtures, logs, build artifacts, exports, and staging copies can leak the same
data as the live database. Use synthetic data by default and treat any necessary
production-shaped copy as private, temporary, access-controlled, and deletable.

## Explicit non-goals

- Inviting friends.
- Changing visible family behavior while proving infrastructure.
- Keeping indefinite dual writes after cutover.

## Evidence after completion

Pending. Retain parity results, bundle inspection, migration rehearsal,
export/restore evidence, and confirmation that the family deployment did not
change unexpectedly.

