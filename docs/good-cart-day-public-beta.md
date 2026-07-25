# Good Cart Day public-beta foundation

This folder is a separate public-safe application. It has no imports from the
BasketSense family app, no family D1 binding, no receipt-image binding, and no
audited family fixtures. It is the only source eligible to become the public
marketing deployment.

## What is implemented

- `goodcartday.com` marketing surface with synthetic list and receipt examples.
- Public privacy and terms pages, plus honest independent-product language.
- Invite-only beta-interest endpoint with explicit consent, generic responses,
  honeypot, Turnstile verification, a D1-backed ten-minute rate limit, and a
  separate interest database binding.
- Google OAuth start, magic-link fallback, PKCE callback, JWT verification
  against Supabase JWKS, and secure host-only cookie handling.
- A neutral authenticated-but-uninvited state. Authentication alone cannot
  create a household or show product data.

## Required operator configuration before publishing

1. Buy `goodcartday.com`, create DNS for `goodcartday.com` and
   `app.goodcartday.com`, and connect each hostname to the appropriate
   Cloudflare deployment. Domain availability is not trademark clearance.
2. Create two new Cloudflare environments with synthetic data only:
   `goodcartday-marketing` for the public site and `goodcartday-app` for the
   protected beta product. Do not rebind the private BasketSense deployment.
3. Bind a dedicated D1 database as `BETA_INTEREST` to the marketing project.
   It may contain only beta-interest records and rate-limit hashes.
4. Create a Supabase project for Auth only. Configure Google OAuth, magic-link
   email, approved redirect `https://app.goodcartday.com/api/auth/callback`,
   and a branded auth domain before broadening the beta.
5. Use an asymmetric Supabase signing key so the Worker can validate JWTs using
   the project JWKS. Set all variables listed in `good-cart-day/.env.example`
   as runtime secrets/values, never in source control.
6. Create a Turnstile widget for `goodcartday.com`, provide its site key to the
   public form integration, and set `TURNSTILE_SECRET_KEY` in the Worker.

The current landing form intentionally refuses real interest submissions until
Turnstile is wired. This is safer than silently accepting an unprotected public
email collection endpoint.

## Before admitting anyone

This foundation does not yet grant product access. First complete the tenant
repository, household lifecycle, R2 authorization, migration rehearsal,
export/restore, and cross-household tests specified by Gate B. Existing
BasketSense family data must remain in the private deployment until parity and
rollback evidence exists.
