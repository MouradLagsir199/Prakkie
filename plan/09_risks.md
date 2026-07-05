# Risks & open questions

## Carried over from spec 01 §21

1. **Platform risk** — AH ships social import; mitigation: cross-chain neutrality AH structurally can't match.
2. **Data-source risk** — unofficial chain APIs change/block anytime; mitigations per docs/02 §5: polite low-volume ingestion, caching, provider-agnostic `Product` schema (commercial multi-chain API is a drop-in swap), affiliate/API partnerships as endgame.
3. **Video import cost** — the swing cost: premium gate, per-user quotas, URL-hash cache, per-actor hard caps.
4. **Legal** — import attribution/platform ToS; product-data posture (docs/02 §5); discovery-feed crawling/display (docs/05 §4). Written NL counsel advice before public launch; feed display depth pending that advice.
5. **Cold-start matching** — seeded NL lexicon (doubles as the matching harness); learning loop compounds.
6. **Open product decisions** — Prijzen chain set (recommend: onboarding selection); AH affiliate vs neutrality.

## Build-specific (added)

| Risk | Mitigation |
|---|---|
| **Chain API shape drift** (11 unofficial APIs) | Raw snapshots to Blob **before** parsing → fix parser, re-parse history, zero days lost; nightly canary + delta-spike signal detect within 24 h; per-chain kill switch; "prijzen van {datum}" honesty. |
| **Apify actor deprecation** (several IDs are third-party) | Actor IDs in config, not code; fixtures keep the parser testable through swaps; per-platform fallback ladders already exist; weekly one-URL-per-platform live smoke (cents). |
| **Expo share-extension iOS review risk** (B1 = primary path) | Clipboard detection as fully equivalent fallback from day one; extension in TestFlight on the *first* EAS build; extension minimal (URL handoff only). |
| **PG B1ms burst-credit exhaustion** (nightly 11-chain upserts) | Staggered jobs, delta-writes only, batched upserts/`COPY`; `cpu_credits_remaining` alert; escape hatch B2s (+≈€15 — flag to owner first). |
| **Consumption cold starts** vs the "12 s" promise | Fast paths are seconds anyway; offline-readable shell masks it; ~€0 warm-up ping in NL waking hours; Flex Consumption only as a measured later move. |
| **Auth choice lock-in** | ADR-0004 = custom JWT (portable, €0, household claims ours) — confirmed in the approved plan; revisit only if MFA/compliance demands grow. |
| **App-store review of scraped content** (feed + prices) | Feed = title+image+attribution only (same mitigation as legal); demonstrable takedown workflow; **Ontdek behind a server flag** so a rejected build ships with it disabled, no native resubmit. |
| **Fixture/corpus staleness** (green CI, broken product) | Weekly live accuracy run + monthly ritual: re-record 10% of fixtures, append new viral formats. |
