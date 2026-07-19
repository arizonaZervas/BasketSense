# BS-005 — Multi-tenant identity and isolation

**Status:** Blocked by BS-004  
**Priority:** 5  
**Decision gate:** Gate B

## Outcome

Every request, query, mutation, receipt image, and derived view is scoped to a
verified user with an active membership in exactly the household being served.

## Rationale

Database capacity is not the first multi-tenant risk; accidental data access is.
The current email identity, fixed household, two-user auto-enrollment, and
scattered raw queries must be replaced before any friend receives access.

## Dependencies

- BS-004 provides a synthetic staging environment, migration discipline, and
  family-data separation.
- A managed-auth provider with verified identity and stable subject IDs is
  selected through an ADR.
- One shared D1 remains the agreed beta topology.

## Smallest test

Create two synthetic households with an owner and member in each. Run the same
list, receipt, dashboard, feedback, and image requests using valid identifiers
from the other household and verify that every access returns `404` without
revealing whether the resource exists.

## Intended scope

- Stable internal users keyed to a managed-auth subject rather than email.
- Memberships with household, role, status, joined, and removed timestamps.
- A server-created tenant context containing user, household, membership, and
  role.
- Tenant-scoped repositories for all database access.
- Defense-in-depth household keys and indexes on tenant-owned child data where
  parent-only scope could permit accidental cross-household references.
- Household-prefixed private R2 keys with membership checks before every read.
- Minimal failed-authorization security events without raw receipt content.

## Acceptance criteria

- No API trusts a household ID supplied by the client.
- Every GET, POST, PATCH, upload, and image-read path uses tenant context.
- Owner, member, removed member, unauthenticated user, and other-household
  authorization cases are automated for every route.
- Cross-household foreign-key and identifier attachment attempts fail.
- Removed members lose API and R2 access immediately.
- Logs and errors do not disclose resource existence or sensitive row content.
- The current family household passes exact parity after migration.

## Privacy risks

A missing tenant predicate can expose a household's entire spending history.
Defense must exist in identity resolution, repositories, schema relationships,
route tests, object-key policy, and production monitoring rather than relying on
developer memory.

## Explicit non-goals

- Building password authentication.
- Public signup.
- Multiple active households in the beta UI.
- Per-household D1 databases.

## Evidence after completion

Pending. Attach the route authorization matrix, cross-tenant test results,
schema backfill verification, R2 isolation tests, and family parity report.

