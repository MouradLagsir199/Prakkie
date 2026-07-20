# Release workflow — dev → production

Two environments, one clean loop: build against **dev**, verify on a device, then promote to **production**.

## Environments

| | Dev | Production |
|---|---|---|
| Azure RG | `prakkie-dev` | `prakkie-prod` |
| API base | `https://func-prakkie-api-dev.azurewebsites.net/api` | `https://func-prakkie-api-prod.azurewebsites.net/api` |
| Key Vault | `kv-prakkie-dev` | `kv-prakkie-prod` |
| Postgres | `pg-prakkie-dev-ne` | `pg-prakkie-prod` |
| EAS profile | `preview` (APK) / `development` | `production` |

## Backend (Azure Functions + DB)

Deploys run through GitHub Actions via OIDC — no long-lived secrets in GitHub. See [.github/workflows/deploy.yml](../.github/workflows/deploy.yml).

- **Dev:** every push to `main` auto-deploys both Function apps + runs migrations against `prakkie-dev`.
- **Prod:** manually triggered — `gh workflow run Deploy -f environment=prod` (or the Actions UI). The `prod` GitHub Environment can gate this with a required reviewer.
- **Infra (Bicep):** stays manual, never in the workflow: `./scripts/deploy.ps1 -Env <dev|prod> [-SkipApps]`.

Secrets (OpenAI, Apify, Postgres, JWT) live only in each environment's Key Vault; the Function apps read them via Key Vault references, and `db-migrate` reads PG passwords from Key Vault at runtime.

## Mobile (Expo / EAS)

The API base URL and Google client id are baked in per EAS profile via `EXPO_PUBLIC_*` env in [apps/mobile/eas.json](../apps/mobile/eas.json).

### The loop
1. **Develop** locally against dev (`pnpm --dir apps/mobile start`).
2. **Push** backend changes to `main` → dev API updates automatically.
3. **Build a dev APK** to test on a real device / emulator:
   ```bash
   cd apps/mobile
   eas build -p android --profile preview      # internal-distribution APK, points at dev API
   ```
   Install the resulting APK on the emulator/device and verify.
4. **Promote backend to prod** when happy: `gh workflow run Deploy -f environment=prod`.
5. **Build the production app** (points at the prod API):
   ```bash
   eas build -p android --profile production   # AAB for Play Store
   eas build -p ios --profile production       # for TestFlight / App Store
   ```
6. **Submit** to the stores: `eas submit -p android --profile production` / `eas submit -p ios --profile production`.

### Verifying the production app on an emulator
`production` builds an Android **App Bundle (.aab)**, which can't be installed directly on an emulator. To smoke-test the prod API from an emulator, either:
- temporarily add an APK-output prod profile, or
- run the dev client with `EXPO_PUBLIC_API_URL` pointed at the prod API.

See "Emulator" below.

## OAuth

- **Google:** one Google Cloud project/OAuth clients shared by dev and prod (reused). Each Android build's signing-key **SHA-1** must be registered on the Android OAuth client in Google Cloud Console → Credentials. Get a build's SHA-1 with `eas credentials -p android`.
- **Apple:** native Sign in with Apple uses the app's bundle id `nl.prakkie.app` as the audience (`APPLE_CLIENT_IDS`, set identically in dev and prod). No per-environment Apple config needed.

## Emulator (Android)

```bash
# list installed AVDs
emulator -list-avds
# launch one
emulator -avd <name>
# install a built APK
adb install path/to/app.apk
```
If no AVD exists, create one via Android Studio ▸ Device Manager (or `sdkmanager`/`avdmanager`).
