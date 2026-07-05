# Inputs still needed from the owner

Tick these off in [`progress.md`](progress.md) as they land.

1. **Azure subscription ID** + sign-off on RG names `prakkie-dev`/`prakkie-prod` (West Europe). CLI context only — never in the repo.
2. **Deploy identity:** owner runs `az login` for first deploys, or approve a service principal with **GitHub OIDC federation** (recommended — no stored secret anywhere).
3. **Apple Developer** (team ID) + **Google Play** developer accounts — who owns them?
4. **Sign in with Apple + Google OAuth** client IDs/secrets from those consoles (into Key Vault via `setup-secrets`, by name).
5. **Apify account** with the docs/06 actors rentable/enabled; confirm `APIFY_API_TOKEN` belongs to it.
6. **OpenAI org/project** + monthly hard limit (suggest €15, mirroring the budget line) + allowed model tier for `parseRecipe`.
7. **Picnic decision:** create a dedicated low-privilege account for the connector (highest ToS-risk chain), or build it last behind its kill switch and enable post-launch?
8. **Domain:** register `prakkie.nl`? Needed for the web app, PrakkieBot contact URL (`https://prakkie.nl/bot`), deep links and OAuth redirects.
9. **Prijzen-tab chain set:** confirm the recommendation — the chains the user selected in onboarding.
10. **Mockup re-export** "Bordje" → "Prakkie" (all 7 HTML titles verified stale; blocks pixel-comparison only).
11. **RevenueCat** account (recommended) vs direct StoreKit2/Play Billing — needed before WS10 wires the premium gate.
12. **Legal budget:** one round of written NL counsel advice on (a) product-data ingestion posture and (b) discovery-feed display depth — (b) blocks the Ontdek detail-view scope.
13. **Ontdek screen sign-off** — the discovery segment is designed strictly from existing tokens but is not one of the 7 approved mockups; owner approval required before WS7 UI build (docs/04 §4).
