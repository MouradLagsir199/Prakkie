# ADR-0004 — Auth: own lightweight JWT identity (not Microsoft Entra External ID)

**Status:** Accepted · **Date:** 2026-07-05

## Decision

The API owns identity. Native Sign in with Apple / Google One Tap on device → app sends the provider `id_token` → API verifies signature against Apple/Google JWKS → upserts `app.users` → issues our own **access JWT (15 min)** + **rotating refresh token** (hash stored per device row; reuse detection revokes the family). Email+password (argon2id) as the third option. **Guest mode** = anonymous user row + device-bound refresh token, upgraded in place to a full account after the first import (spec A1/A3) — the user id never changes. `household_id` and `tier` are JWT claims, re-issued on membership/subscription change. Signing key lives in Key Vault.

## Rationale

Guest-first onboarding is a hard product requirement and is genuinely awkward in Entra External ID; Apple sign-in there requires custom-IdP federation with browser-redirect flows (worse UX than native buttons); the user store living outside our Postgres complicates the P0 GDPR export/delete and household modelling; and it is the stickiest possible Azure dependency, contradicting the portability stance of ADR-0001. Custom JWT auth is a small amount of well-trodden code, costs €0, and keeps every claim ours to model.

## Consequences

We own token hygiene (rotation, revocation, JWKS caching) and must test it well. Revisit if MFA/compliance requirements grow beyond what's reasonable to self-host.
