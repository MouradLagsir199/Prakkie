<#
.SYNOPSIS
  Log interactively into Picnic (including SMS 2FA) and store only the resulting
  auth key in the Prakkie Key Vault. The email, password, SMS code and auth key
  are never printed or committed.

.EXAMPLE
  ./scripts/bootstrap-picnic-auth.ps1 -Env dev
#>
param(
    [ValidateSet('dev', 'prod')]
    [string]$Env = 'dev'
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path $PSScriptRoot -Parent
$tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
$authFile = Join-Path $tempRoot ("prakkie-picnic-auth-{0}.key" -f [guid]::NewGuid())
$passwordPtr = [IntPtr]::Zero

try {
    $email = (Read-Host 'Picnic e-mailadres').Trim()
    if (-not $email) { throw 'Picnic e-mailadres is verplicht.' }
    $securePassword = Read-Host 'Picnic wachtwoord' -AsSecureString
    $passwordPtr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($securePassword)
    $plainPassword = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($passwordPtr)

    $env:PICNIC_EMAIL = $email
    $env:PICNIC_PASSWORD = $plainPassword
    Push-Location $repoRoot
    try {
        python -m scrapers.picnic --interactive-auth --auth-only --auth-key-output $authFile
        if ($LASTEXITCODE -ne 0) { throw 'Picnic-authenticatie is mislukt.' }
    }
    finally {
        Pop-Location
    }

    $resolvedAuthFile = [IO.Path]::GetFullPath($authFile)
    if (-not $resolvedAuthFile.StartsWith($tempRoot, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'Onveilig tijdelijk auth-pad geweigerd.'
    }
    if (-not (Test-Path -LiteralPath $resolvedAuthFile)) {
        throw 'Picnic-authenticatie leverde geen auth-bestand op.'
    }

    az keyvault secret set `
        --vault-name "kv-prakkie-$Env" `
        --name 'PICNIC-AUTH-KEY' `
        --file $resolvedAuthFile `
        --encoding utf-8 `
        --output none
    if ($LASTEXITCODE -ne 0) { throw 'Opslaan van PICNIC-AUTH-KEY in Key Vault is mislukt.' }
    Write-Host "Picnic-authenticatie staat veilig in kv-prakkie-$Env."
}
finally {
    Remove-Item Env:PICNIC_EMAIL -ErrorAction SilentlyContinue
    Remove-Item Env:PICNIC_PASSWORD -ErrorAction SilentlyContinue
    $plainPassword = $null
    $securePassword = $null
    $email = $null
    if ($passwordPtr -ne [IntPtr]::Zero) {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($passwordPtr)
    }
    $resolved = [IO.Path]::GetFullPath($authFile)
    if ($resolved.StartsWith($tempRoot, [StringComparison]::OrdinalIgnoreCase) -and
        (Test-Path -LiteralPath $resolved)) {
        Remove-Item -LiteralPath $resolved -Force
    }
}
