# BS-004A — Public-safe boundary and marketing surface

**Status:** In progress  
**Priority:** 4  
**Decision gate:** Gate B

## Outcome

Good Cart Day has a separately deployable, public marketing surface that uses
synthetic examples only and cannot render, import, or bind the private family
receipt history.

## Rationale

Making the existing family site public would expose an unacceptable boundary:
its server bundle and bootstrap assumptions contain household-specific history.
A clean parallel application lets us test brand, demand, and identity without
changing the Saturday experience Harsh and Navni already trust.

## Dependencies

- Good Cart Day domain purchase and DNS are operator-owned prerequisites.
- Supabase, Turnstile, and dedicated Cloudflare bindings must be configured
  before public beta-interest collection or sign-in can be enabled.

## Smallest test

Deploy the separate Good Cart Day application with synthetic data, submit a
protected beta-interest request, and search its rendered HTML, Worker bundle,
headers, logs, and social image for seeded family strings.

## Acceptance criteria

- Marketing app has no imports from the family application or fixtures.
- No family receipt/product string appears in public artifacts.
- Public interest storage is distinct from product/household storage.
- Anonymous `/app` access does not expose household data.
- Authenticated-but-uninvited access is neutral and creates no household.
- Privacy, terms, accessible mobile controls, visible focus, and reduced-motion
  behavior are present.

## Privacy risks

Email interest collection can be spammed or become an unexpected marketing
database. Require consent, Turnstile, rate limits, generic responses, and no
marketing automation.

## Evidence after completion

Pending: public-bundle scan, deployed route checks, Turnstile test, and
synthetic-only environment proof.
