# BasketSense prioritized product backlog

This directory is the canonical source of truth for future BasketSense work.
It records decisions and sequencing only; it does not authorize application,
database, authentication, migration, or deployment changes.

BasketSense remains household-first. Work belongs here only when it improves a
household decision, strengthens data trust, reduces weekly effort, or unlocks a
validated next stage without making the Costco ritual less enjoyable.

## Status vocabulary

| Status | Meaning |
| --- | --- |
| Proposed | Agreed direction, but not yet eligible to start. |
| Ready | Dependencies and acceptance criteria are resolved. |
| In progress | The single major item currently being implemented. |
| Validated | Acceptance criteria passed and user evidence was recorded. |
| Blocked | A named dependency or decision gate prevents progress. |
| Parked | Explicitly deferred; see [`parking-lot.md`](parking-lot.md). |

## Ordered backlog

The order is intentional. Urgent bugs in the current weekly loop may interrupt
the sequence, but feature work may not silently skip a decision gate.

| Order | ID | Item | Status | Completion outcome |
| ---: | --- | --- | --- | --- |
| 1 | [BS-001](BS-001-family-closed-loop.md) | Prove the family closed loop | Ready | Harsh and Navni complete four measured Saturday cycles. |
| 2 | [BS-002](BS-002-live-data-visibility.md) | Live data visibility and ownership | In progress | Owners can safely explore and export actual hosted household data. |
| 3 | [BS-003](BS-003-recommendation-engine-v2.md) | Recommendation engine v2 | Proposed | Explainable, household-specific recommendations pass shadow evaluation. |
| 4 | [BS-004](BS-004-production-safety.md) | Production safety and migration foundation | Blocked by Gate A | Private family data and migration risk are removed from the external-user path. |
| 5 | [BS-005](BS-005-tenant-isolation.md) | Multi-tenant identity and isolation | Blocked by BS-004 | Every request and object is scoped to an authenticated household membership. |
| 6 | [BS-006](BS-006-household-lifecycle.md) | Household lifecycle | Blocked by BS-005 | Owners can safely create and manage a two-person household. |
| 7 | [BS-007](BS-007-zero-history-onboarding.md) | Zero-history onboarding | Blocked by BS-006 | A new household reaches a useful first list within five minutes. |
| 8 | [BS-008](BS-008-batch-receipt-ingestion.md) | Batch receipt ingestion | Blocked by BS-005 | Historical PDFs and photos can be ingested safely with focused review. |
| 9 | [BS-009](BS-009-privacy-and-operations.md) | Privacy and operational readiness | Blocked by BS-005 | Export, deletion, retention, recovery, and operating controls are proven. |
| 10 | [BS-010](BS-010-controlled-friend-beta.md) | Controlled friend beta | Blocked by Gate B | One, then five, then ten invited households complete the weekly loop safely. |
| 11 | [BS-011](BS-011-measured-scale.md) | Scale based on measured usage | Blocked by BS-010 | Saturday-shaped load for 100 households is understood and measured bottlenecks are addressed. |

## Decision gates

### Gate A — continue beyond the household product

Required after BS-001 through BS-003:

- Both spouses repeatedly use the shared list.
- Dashboard totals remain accurate.
- Receipt review is acceptably quick.
- Recommendations reduce planning decisions instead of adding noise.
- The Costco ritual remains equally or more enjoyable.

If Gate A fails, simplify the current product before undertaking multi-tenancy.

### Gate B — allow the first outside household

Required after BS-004 through BS-009:

- Current-household parity tests pass.
- No private household data appears in unauthenticated HTML or bundles.
- Owner, member, removed-member, and cross-household authorization tests pass.
- Export and restore have been rehearsed.
- Duplicate or failed imports cannot double-count spending.
- Unreconciled receipts cannot affect exact metrics.
- R2 images remain private and household-authorized.
- Member removal revokes access immediately.

### Gate C — expand beyond the first pilot

Required during BS-010:

- One outside household independently completes onboarding, planning,
  shopping, receipt ingestion, and review.
- Support and correction effort is sustainable.
- No isolation, privacy, or data-loss incident occurs.
- The household chooses to use BasketSense again the following week.

## Agreed architectural defaults

- Preserve the current family deployment and migrate only through shadow
  parity and rollback gates.
- Keep React, Next/vinext, Cloudflare Workers, D1, and R2.
- Use one shared D1 for the invite-only beta with strict application-level
  tenant isolation.
- Use managed authentication; do not implement passwords.
- Never trust a client-provided household ID.
- Keep receipt images private and household-prefixed.
- Keep recommendation learning household-specific.
- Require zero historical receipts; recommend recent history optionally.
- Design for hundreds, but validate with 5–10 households first.
- Do not migrate to Supabase merely to obtain a database browser.
- Do not expose an arbitrary SQL console inside BasketSense.

## Backlog governance

- This ordered list is the source of truth.
- Only one major item may be in progress at a time, apart from urgent
  weekly-loop bugs.
- An item becomes Ready only when dependencies, the smallest test, and
  acceptance criteria are resolved.
- Code complete is not Validated; tests and household evidence are required.
- Reprioritization requires an explicit decision between Harsh and Codex and
  an update to this index.
- New ideas start in the parking lot unless their priority and gate impact are
  explicitly agreed.

## Backlog item contract

Every item records:

1. the outcome and household behavior it should improve;
2. why it belongs at its current priority;
3. dependencies and explicit non-goals;
4. the smallest reversible test;
5. acceptance criteria and privacy risks; and
6. evidence after completion.

If these cannot be stated clearly, the idea is not ready for implementation.

## Completed foundations

- [Reconciled D1 dashboard cutover](completed/d1-dashboard-cutover.md) — the
  hydrated dashboard now reads reconciled D1 history while the audited
  January–July baseline remains a parity fixture.

## Architecture decisions

Future decisions and their status live in [`decisions/`](decisions/README.md).
Deferred ideas live in [`parking-lot.md`](parking-lot.md).
