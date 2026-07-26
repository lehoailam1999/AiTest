#Requires -Version 5.1
$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
Set-Location (Join-Path $Root "api")
$py = Join-Path $Root "api\.venv\Scripts\python.exe"
if (-not (Test-Path $py)) {
  Write-Error "Thieu api/.venv. Chay: cd api; python -m venv .venv; .\.venv\Scripts\pip install -r requirements.txt"
}
& $py -m pytest tests/test_prefer_context_packet.py -q
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
& $py -m unittest tests.test_output_layout tests.test_business_analyzer_p9 -q
exit $LASTEXITCODE
