#Requires -Version 5.1
$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root

function Step([string]$title) {
  Write-Host ""
  Write-Host "=== $title ===" -ForegroundColor Cyan
}

$failed = 0

Step "P0 - ide-protocol"
Push-Location (Join-Path $Root "packages\ide-protocol")
try {
  npm test
  if ($LASTEXITCODE -ne 0) { $failed++ }
} finally { Pop-Location }

Step "P3+P5 - desktop"
Push-Location (Join-Path $Root "desktop")
try {
  npm run test:unit
  if ($LASTEXITCODE -ne 0) { $failed++ }
} finally { Pop-Location }

Step "P4+P5 - API"
$py = Join-Path $Root "api\.venv\Scripts\python.exe"
if (-not (Test-Path $py)) {
  Write-Host "[WARN] Missing api/.venv - skip API tests"
  Write-Host "Create: cd api; python -m venv .venv; .\.venv\Scripts\pip install -r requirements.txt"
  $failed++
} else {
  Push-Location (Join-Path $Root "api")
  try {
    & $py -m pytest tests/test_prefer_context_packet.py -q
    if ($LASTEXITCODE -ne 0) { $failed++ }
    & $py -m unittest tests.test_output_layout -q
    if ($LASTEXITCODE -ne 0) { $failed++ }
  } finally { Pop-Location }
}

Write-Host ""
if ($failed -gt 0) {
  Write-Host "FAILED: $failed suite(s)" -ForegroundColor Red
  exit 1
}
Write-Host "ALL TESTS PASSED (P0-P5 contracts)" -ForegroundColor Green
exit 0
