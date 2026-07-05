<#
.SYNOPSIS
  One-command deploy (plan/06_iac.md §4):
    1. az deployment sub create (what-if first; idempotent RG + everything)
    2. seed generated secrets (PG passwords, JWT signing key) into Key Vault if absent
    3. bundle + publish both Function apps (run-from-package)
    4. swa deploy web (when apps/web exists)
    5. run SQL migrations (when migrations exist)

  Works locally (needs only az login) and in CI (OIDC).

.EXAMPLE
  ./scripts/deploy.ps1 -Env dev
  ./scripts/deploy.ps1 -Env dev -SkipInfra          # apps only
  ./scripts/deploy.ps1 -Env prod -Confirm:$true     # prod is gated
#>
param(
    [Parameter(Mandatory)]
    [ValidateSet('dev', 'prod')]
    [string]$Env,

    [switch]$SkipInfra,
    [switch]$SkipApps,
    [string]$AdminIp = '',
    [switch]$Force
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path $PSScriptRoot -Parent
$infraDir = Join-Path $repoRoot 'infra'
$location = 'westeurope'
$vaultName = "kv-prakkie-$Env"
$apps = @(
    @{ Name = "func-prakkie-api-$Env"; Dir = Join-Path $repoRoot 'services/functions-api' },
    @{ Name = "func-prakkie-ingest-$Env"; Dir = Join-Path $repoRoot 'services/functions-ingest' }
)

function New-RandomSecret([int]$Length = 40) {
    # Crypto-random, alphanumeric-only (safe in connection strings), guaranteed mixed categories
    $chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
    do {
        $bytes = [byte[]]::new($Length)
        [System.Security.Cryptography.RandomNumberGenerator]::Fill($bytes)
        $s = -join ($bytes | ForEach-Object { $chars[$_ % $chars.Length] })
    } until ($s -cmatch '[a-z]' -and $s -cmatch '[A-Z]' -and $s -match '[0-9]')
    return $s
}

function Get-KvSecretOrNull([string]$Name) {
    $v = az keyvault secret show --vault-name $vaultName --name $Name --query value -o tsv 2>$null
    if ($LASTEXITCODE -ne 0) { return $null }
    return $v
}

function Set-KvSecretIfAbsent([string]$Name, [string]$Value) {
    if (Get-KvSecretOrNull $Name) { Write-Host "  $Name already set"; return }
    # RBAC propagation for a freshly assigned role can lag — retry briefly
    for ($i = 1; $i -le 6; $i++) {
        $env:PRAKKIE_SECRET_VALUE = $Value
        az keyvault secret set --vault-name $vaultName --name $Name --value "$env:PRAKKIE_SECRET_VALUE" --output none 2>$null
        $ok = ($LASTEXITCODE -eq 0)
        $env:PRAKKIE_SECRET_VALUE = $null
        if ($ok) { Write-Host "  $Name seeded"; return }
        Start-Sleep -Seconds 10
    }
    throw "Failed to set secret $Name (name only; value not shown)"
}

# --- context ---
$account = az account show --query "{name:name, id:id}" -o json | ConvertFrom-Json
if (-not $account) { throw "Not logged in — run az login first." }
Write-Host "Deploying Prakkie [$Env] to subscription '$($account.name)' ($($account.id))"

if ($Env -eq 'prod' -and -not $Force) {
    $answer = Read-Host "This deploys PRODUCTION. Type 'prakkie-prod' to continue"
    if ($answer -ne 'prakkie-prod') { throw 'Aborted.' }
}

# --- 1. infra ---
if (-not $SkipInfra) {
    # PG admin password: reuse the vault copy when it exists, generate on first run
    $pgAdminPassword = Get-KvSecretOrNull 'PG-ADMIN-PASSWORD'
    $isNewPgPassword = $false
    if (-not $pgAdminPassword) {
        $pgAdminPassword = New-RandomSecret
        $isNewPgPassword = $true
        Write-Host 'Generated new PG admin password (will be stored in Key Vault after deploy).'
    }

    if (-not $AdminIp) {
        try { $AdminIp = (Invoke-RestMethod -Uri 'https://api.ipify.org' -TimeoutSec 10).Trim() } catch { $AdminIp = '' }
        if ($AdminIp) { Write-Host "Using detected public IP for the PG admin firewall rule." }
    }

    Write-Host "`n--- what-if ---"
    az deployment sub what-if `
        --name "prakkie-$Env" --location $location `
        --template-file (Join-Path $infraDir 'main.bicep') `
        --parameters (Join-Path $infraDir "main.$Env.bicepparam") `
        --parameters pgAdminPassword="$pgAdminPassword" adminIpAddress="$AdminIp"
    if ($LASTEXITCODE -ne 0) { throw 'what-if failed' }

    Write-Host "`n--- deploy ---"
    az deployment sub create `
        --name "prakkie-$Env" --location $location `
        --template-file (Join-Path $infraDir 'main.bicep') `
        --parameters (Join-Path $infraDir "main.$Env.bicepparam") `
        --parameters pgAdminPassword="$pgAdminPassword" adminIpAddress="$AdminIp" `
        --output table
    if ($LASTEXITCODE -ne 0) { throw 'deployment failed' }

    # --- 2. seed secrets ---
    Write-Host "`n--- secrets ---"
    # The deployer needs data-plane rights on the RBAC-mode vault (Owner alone is control-plane only)
    $me = az ad signed-in-user show --query id -o tsv 2>$null
    if ($me) {
        $vaultId = az keyvault show --name $vaultName --query id -o tsv
        az role assignment create --role 'Key Vault Secrets Officer' --assignee-object-id $me `
            --assignee-principal-type User --scope $vaultId --output none 2>$null
    }
    if ($isNewPgPassword) { Set-KvSecretIfAbsent 'PG-ADMIN-PASSWORD' $pgAdminPassword }
    Set-KvSecretIfAbsent 'JWT-SIGNING-KEY' (New-RandomSecret 64)
    Set-KvSecretIfAbsent 'PG-APP-PASSWORD' (New-RandomSecret)
    Set-KvSecretIfAbsent 'PG-INGEST-PASSWORD' (New-RandomSecret)
    $pgAdminPassword = $null
}

# --- 3. Function apps ---
if (-not $SkipApps) {
    Write-Host "`n--- function apps ---"
    Push-Location $repoRoot
    try { pnpm install --frozen-lockfile | Out-Null } finally { Pop-Location }

    foreach ($app in $apps) {
        Write-Host "Bundling $($app.Name)..."
        $stage = Join-Path $app.Dir '.publish'
        if (Test-Path $stage) { Remove-Item -Recurse -Force $stage -Confirm:$false }
        New-Item -ItemType Directory -Path $stage | Out-Null

        node (Join-Path $PSScriptRoot 'bundle-functions.mjs') $app.Dir
        if ($LASTEXITCODE -ne 0) { throw "esbuild failed for $($app.Name)" }

        Copy-Item (Join-Path $app.Dir 'host.json') $stage
        @{ name = Split-Path $app.Dir -Leaf; version = '0.0.0'; main = 'dist/src/functions/*.js' } |
            ConvertTo-Json | Set-Content (Join-Path $stage 'package.json')

        Write-Host "Publishing $($app.Name)..."
        Push-Location $stage
        try {
            func azure functionapp publish $app.Name --no-build --javascript
            if ($LASTEXITCODE -ne 0) { throw "publish failed for $($app.Name)" }
        }
        finally { Pop-Location }
    }

    # --- healthz smoke test ---
    Write-Host "`n--- healthz ---"
    foreach ($app in $apps) {
        $url = "https://$($app.Name).azurewebsites.net/api/healthz"
        $status = $null
        for ($i = 1; $i -le 10; $i++) {
            try { $status = (Invoke-WebRequest -Uri $url -TimeoutSec 30 -SkipHttpErrorCheck).StatusCode } catch { $status = 'ERR' }
            if ($status -eq 200) { break }
            Start-Sleep -Seconds 15
        }
        Write-Host "$url -> $status"
        if ($status -ne 200) { throw "healthz failed for $($app.Name)" }
    }
}

# --- 4. web (Static Web Apps) ---
if (Test-Path (Join-Path $repoRoot 'apps/web/package.json')) {
    Write-Host "`n--- web: apps/web found, run swa deploy here (not yet wired) ---"
}

# --- 5. migrations ---
if (Test-Path (Join-Path $repoRoot 'services/migrations')) {
    Write-Host "`n--- migrations: services/migrations found, wire runner here (WS1) ---"
}

Write-Host "`nDeploy [$Env] complete."
