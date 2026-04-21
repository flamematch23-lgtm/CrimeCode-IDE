# Generate a self-signed code-signing certificate for OpenCode Dev builds.
# Usage: powershell -ExecutionPolicy Bypass -File scripts/generate-cert.ps1
# Output: sidecar/cert.pfx (password: "opencode")
#
# NOTE: Self-signed certs do NOT remove SmartScreen warnings. They only
# add a verifiable publisher name and integrity check to the binary.

$ErrorActionPreference = "Stop"

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = Split-Path -Parent $here
$out = Join-Path $root "sidecar\cert.pfx"
$pass = if ($env:SIGN_PASS) { $env:SIGN_PASS } else { "" }
$subject = if ($env:SIGN_PUBLISHER) { $env:SIGN_PUBLISHER } else { "OpenCode Dev (Self-signed)" }

Write-Host "Generating self-signed cert: CN=$subject"

$cert = New-SelfSignedCertificate `
  -Type CodeSigningCert `
  -Subject "CN=$subject" `
  -KeyAlgorithm RSA `
  -KeyLength 2048 `
  -HashAlgorithm SHA256 `
  -CertStoreLocation "Cert:\CurrentUser\My" `
  -NotAfter (Get-Date).AddYears(5)

$secure = if ($pass -eq "") { (New-Object System.Security.SecureString) } else { ConvertTo-SecureString -String $pass -Force -AsPlainText }
Export-PfxCertificate -Cert $cert -FilePath $out -Password $secure | Out-Null

Write-Host "Wrote $out (password: $pass)"
Write-Host ""
Write-Host "To trust this cert locally (optional, removes some warnings):"
Write-Host "  Import-PfxCertificate -FilePath '$out' -CertStoreLocation Cert:\LocalMachine\Root -Password (ConvertTo-SecureString '$pass' -AsPlainText -Force)"
