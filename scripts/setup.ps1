#Requires -Version 5.1
<#
.SYNOPSIS
  First-time setup after clone: Postgres, API venv, migrate, protocol + desktop npm.
.EXAMPLE
  npm run setup
  pwsh -File ./scripts/setup.ps1
  pwsh -File ./scripts/setup.ps1 -SkipExtension
#>
param(
  [switch]$SkipExtension,
  [switch]$SkipDb
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
if (-not $Root) { $Root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path }
Set-Location $Root

function Require-Cmd([string]$Name) {
  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
    throw "Thieu lenh '$Name' trong PATH. Cai dat roi chay lai npm run setup."
  }
}

Write-Host "=== AITest setup (lan dau sau clone) ===" -ForegroundColor Cyan
Require-Cmd "node"
Require-Cmd "npm"
Require-Cmd "python"
if (-not $SkipDb) { Require-Cmd "docker" }

if (-not $SkipDb) {
  Write-Host "`n=== 1) Postgres (Docker) ===" -ForegroundColor Cyan
  npm run db
  Start-Sleep -Seconds 3
} else {
  Write-Host "`n=== 1) Skip Postgres (-SkipDb) ===" -ForegroundColor Yellow
}

Write-Host "`n=== 2) API Python (.venv + pip + migrate) ===" -ForegroundColor Cyan
$api = Join-Path $Root "api"
Push-Location $api
try {
  if (-not (Test-Path ".env") -and (Test-Path ".env.example")) {
    Copy-Item ".env.example" ".env"
    Write-Host "[INFO] Da tao api/.env tu .env.example"
  }
  $py = Join-Path $api ".venv\Scripts\python.exe"
  if (-not (Test-Path $py)) {
    Write-Host "[INFO] Tao api/.venv ..."
    python -m venv .venv
  }
  if (-not (Test-Path $py)) { throw "Khong tao duoc api/.venv — kiem tra Python 3.12+" }
  & $py -m pip install --upgrade pip
  & $py -m pip install -r requirements.txt
  $alembic = Join-Path $api ".venv\Scripts\alembic.exe"
  if (-not (Test-Path $alembic)) { throw "alembic missing after pip install" }
  Write-Host "[INFO] alembic upgrade head"
  & $alembic upgrade head
  if ($LASTEXITCODE -ne 0) { throw "alembic migrate failed" }
} finally {
  Pop-Location
}

Write-Host "`n=== 3) packages/ide-protocol ===" -ForegroundColor Cyan
npm install --prefix packages/ide-protocol

Write-Host "`n=== 4) desktop npm install ===" -ForegroundColor Cyan
npm install --prefix desktop

if (-not $SkipExtension) {
  Write-Host "`n=== 5) IDE extension ===" -ForegroundColor Cyan
  try {
    npm run extension:install
  } catch {
    Write-Host "[WARN] extension:install that bai (co the chua cai Cursor/VS Code). Bo qua." -ForegroundColor Yellow
    Write-Host $_.Exception.Message -ForegroundColor Yellow
  }
} else {
  Write-Host "`n=== 5) Skip extension (-SkipExtension) ===" -ForegroundColor Yellow
}

Write-Host ""
Write-Host "Setup xong. Chay stack:" -ForegroundColor Green
Write-Host "  npm run up"
Write-Host "Health: http://localhost:8000/health"
Write-Host "Login:  admin@aitest.com / Admin@123"
Write-Host ""
