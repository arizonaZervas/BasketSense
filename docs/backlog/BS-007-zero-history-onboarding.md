# BS-007 — Zero-history onboarding

**Status:** Blocked by BS-006  
**Priority:** 7  
**Decision gate:** Gate B

## Outcome

A new household can sign in, create a household, add a partner, choose 5–10
essentials, and reach a useful shared first list within five minutes without
uploading historical receipts.

## Rationale

Requiring six months of downloads makes users perform the hardest work before
they experience value. History should improve confidence and insights rather
than unlock the product.

## Dependencies

- BS-006 household lifecycle.
- The recommendation engine can represent manual essentials and honest
  low-confidence or unavailable history states.
- Batch history import remains optional and is delivered by BS-008.

## Smallest test

Observe one person who has never seen BasketSense create a synthetic household,
choose essentials, invite a partner, and share a first list without coaching.
Stop and simplify if the flow exceeds five minutes or requires receipt history.

## Intended journey

1. Sign in with verified identity.
2. Name the household and confirm timezone and usual shopping day.
3. Choose or type 5–10 essentials.
4. Create the first active list with editable estimates.
5. Invite the second household member.
6. Offer recent-history import as an optional improvement.

Approximately eight recent weeks or 6–10 receipts may be recommended for basic
cadence evidence, but full history remains optional.

## Acceptance criteria

- Median unassisted time to a useful first list is five minutes or less in the
  initial concierge tests.
- The first list works with zero receipt history.
- The product never invents cadence, confidence, price history, or savings.
- Users can skip, return to, or add more history later.
- Manual essentials remain editable and removable.
- The partner sees the same household and list after accepting the invitation.
- Empty dashboards explain what the first trip will unlock without presenting
  fake charts or household fixtures.

## Privacy risks

Onboarding should collect only information needed for the household experience.
Do not request Costco credentials, household income, payment information, or
unnecessary family-profile details.

## Explicit non-goals

- Mandatory six-month history.
- A generic demographic questionnaire.
- Pretending that starter essentials are personalized predictions.

## Evidence after completion

Pending. Record unassisted completion times, confusion points, abandonment,
history opt-in, and whether the first list was genuinely useful.

