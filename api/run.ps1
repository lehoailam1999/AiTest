#Requires -Version 5.1
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

$python = Join-Path $PSScriptRoot ".venv\Scripts\python.exe"
if (-not (Test-Path $python)) {
    Write-Error "Chua co .venv. Chay: python -m venv .venv; .\.venv\Scripts\pip install -r requirements.txt"
}

if (-not (Test-Path ".env") -and (Test-Path ".env.example")) {
    Copy-Item ".env.example" ".env"
    Write-Host "[INFO] Da tao .env tu .env.example"
}

$port = 5088
if (Test-Path ".env") {
    foreach ($line in Get-Content ".env") {
        if ($line -match '^\s*PORT=(\d+)\s*$') {
            $port = [int]$Matches[1]
            break
        }
    }
}
Write-Host "[INFO] Starting Python API: http://localhost:$port"
Write-Host "[INFO] Health: http://localhost:$port/health (JSON stack=python)"
& $python -m uvicorn app.main:app --reload --host 0.0.0.0 --port $port
