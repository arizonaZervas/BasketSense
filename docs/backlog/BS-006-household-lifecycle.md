# BS-006 — Household lifecycle

**Status:** Blocked by BS-005  
**Priority:** 6  
**Decision gate:** Gate B

## Outcome

An authenticated user can create one household, invite a partner, and safely
manage access throughout the household's lifecycle without operator database
edits.

## Rationale

Automatic enrollment of the first two signed-in emails is appropriate only for
the current private experiment. External households need explicit invitation,
acceptance, removal, and ownership rules.

## Dependencies

- BS-005 stable identity, tenant context, and authorization matrix.
- Managed authentication supplies a verified email and stable subject.
- Email delivery may be deferred for the smallest test by presenting a secure
  invitation link to the owner.

## Smallest test

One synthetic owner creates a household, issues an invitation, a second verified
user accepts it, both use the same list, ownership is transferred, and the
former member is removed and immediately denied access.

## Lifecycle rules

- Owner and member are the only beta roles.
- Two active members is the initial household limit.
- Invitation tokens are random, hashed at rest, single-use, expiring, and bound
  to the invited verified email.
- Owners can revoke pending invitations and remove members.
- The last owner cannot be removed; ownership must first be transferred.
- Removing membership revokes access but preserves necessary historical
  attribution without continuing to expose the member's account.

## Acceptance criteria

- Create, invite, accept, revoke, list, remove, and transfer flows are covered.
- Replayed, expired, revoked, forwarded-to-another-email, and already-used
  invitation tokens fail safely.
- Concurrent acceptance cannot create duplicate memberships.
- Membership changes appear consistently on both household devices.
- Removing a member revokes API and receipt-image access immediately.
- The UI clearly distinguishes pending invitations from active members.

## Privacy risks

Invitations expose email addresses and create account-takeover opportunities.
Do not log tokens, store raw tokens, reveal whether arbitrary emails have
accounts, or allow a forwarded link to bypass verified-email matching.

## Explicit non-goals

- More than two active household members.
- Custom roles or granular shopping permissions.
- A multi-household switcher.
- Public household discovery.

## Evidence after completion

Pending. Attach lifecycle tests, token-security tests, one successful two-user
session, and immediate-revocation evidence.

