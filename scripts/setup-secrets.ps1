<#
.SYNOPSIS
  One-time no-echo Key Vault load from secrets.txt (plan/06_iac.md §5).

  Reads KEY=VALUE lines into variables only — values are never printed, never
  expanded on a command line that lands in history. Failures report the name only.
  Refuses to run if secrets.txt is git-tracked.

.EXAMPLE
  ./scripts/setup-secrets.ps1 -Env dev
#>
param(
    [Parameter(Mandatory)]
    [ValidateSet('dev', 'prod')]
    [string]$Env,

    [string]$SecretsFile = (Join-Path $PSScriptRoot '..' 'secrets.txt')
)

$ErrorActionPreference = 'Stop'
$vaultName = "kv-prakkie-$Env"
$repoRoot = Split-Path $PSScriptRoot -Parent

if (-not (Test-Path $SecretsFile)) {
    Write-Error "No secrets file found at $SecretsFile. Create it with KEY=VALUE lines (it is git-ignored)."
}

# Safety net: refuse if the file is tracked by git
Push-Location $repoRoot
try {
    git ls-files --error-unmatch -- $SecretsFile 2>$null | Out-Null
    if ($LASTEXITCODE -eq 0) {
        throw "REFUSING: $SecretsFile is tracked by git. Untrack it (git rm --cached) before loading secrets."
    }
}
finally { Pop-Location }

Write-Host "Loading secrets from $(Split-Path $SecretsFile -Leaf) into $vaultName (values are never displayed)..."

$loaded = @()
$failed = @()

foreach ($line in Get-Content $SecretsFile) {
    $trimmed = $line.Trim()
    if ($trimmed -eq '' -or $trimmed.StartsWith('#')) { continue }
    $sep = $trimmed.IndexOf('=')
    if ($sep -lt 1) { Write-Warning "Skipping malformed line (no KEY=VALUE)"; continue }

    # Key Vault secret names use dashes (plan/06_iac.md §3): APIFY_API_TOKEN -> APIFY-API-TOKEN
    $name = $trimmed.Substring(0, $sep).Trim().Replace('_', '-')
    $value = $trimmed.Substring($sep + 1).Trim()
    if ($value -eq '') { Write-Warning "Skipping $name (empty value)"; continue }

    try {
        # Value passed via env var so it never appears in a command line
        $env:PRAKKIE_SECRET_VALUE = $value
        az keyvault secret set --vault-name $vaultName --name $name --value "$env:PRAKKIE_SECRET_VALUE" --output none 2>$null
        if ($LASTEXITCODE -ne 0) { throw "az failed" }
        $loaded += $name
    }
    catch {
        $failed += $name
    }
    finally {
        $env:PRAKKIE_SECRET_VALUE = $null
        $value = $null
    }
}

Write-Host "Loaded: $($loaded -join ', ')"
if ($failed.Count -gt 0) {
    Write-Warning "FAILED (names only): $($failed -join ', ')"
    exit 1
}

Write-Host "`nSecrets now in ${vaultName}:"
az keyvault secret list --vault-name $vaultName --query "[].name" --output tsv
