# ADR-001 — Good Cart Day public-beta boundary

**Status:** Accepted (implementation configuration pending)  
**Date:** 2026-07-25

## Decision

Use Good Cart Day as the public brand. Keep the current BasketSense family
deployment private and unchanged. Deploy a separate public marketing
application at `goodcartday.com` and a separately authenticated product
environment at `app.goodcartday.com`.

Supabase supplies identity only: Google OAuth first and email magic links as a
fallback. Cloudflare D1 and private R2 remain the product stores. The Worker
verifies Supabase JWTs through project JWKS and resolves the stable `sub` claim
to internal membership server-side; it never accepts a browser-provided
household id.

## Consequences

- Domain/DNS, Supabase provider configuration, Turnstile, and Cloudflare
  bindings remain explicit operator actions, not source-code defaults.
- Public beta-interest data is stored separately from household data.
- Signed-in users without membership receive a neutral invite-only state.
- Family migration remains blocked until Gate A and BS-004B evidence pass.

## Rejected alternatives

- Making the ChatGPT Sites family URL public.
- Storing Costco credentials or automating Costco login.
- Supabase as the product data store just to obtain a database browser.
- Password authentication and self-service household creation for the beta.
