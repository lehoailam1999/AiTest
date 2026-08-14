#Requires -Version 5.1
<#
.SYNOPSIS
  Khoi dong stack AITest: Postgres + API + Desktop (Tauri).
  Can chay npm run setup it nhat 1 lan sau clone.
.EXAMPLE
  npm run up
#>
$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
if (-not $Root) { $Root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path }
Set-Location $Root

$apiPy = Join-Path $Root "api\.venv\Scripts\python.exe"
$desktopNm = Join-Path $Root "desktop\node_modules"
if (-not (Test-Path $apiPy) -or -not (Test-Path $desktopNm)) {
  Write-Host "Chua setup. Chay truoc:" -ForegroundColor Yellow
  Write-Host "  npm run setup"
  throw "Missing api/.venv or desktop/node_modules"
}

Write-Host "=== 1) Postgres ===" -ForegroundColor Cyan
npm run db
Start-Sleep -Seconds 2

Write-Host "=== 2) Alembic migrate ===" -ForegroundColor Cyan
npm run db:up

Write-Host "=== 3) API (cua so moi) ===" -ForegroundColor Cyan
Start-Process powershell -ArgumentList @(
  "-NoProfile", "-ExecutionPolicy", "Bypass",
  "-NoExit", "-Command",
  "Set-Location '$Root'; npm run start"
)

Write-Host "=== 4) Desktop Tauri (cua so moi) ===" -ForegroundColor Cyan
Start-Process powershell -ArgumentList @(
  "-NoProfile", "-ExecutionPolicy", "Bypass",
  "-NoExit", "-Command",
  "Set-Location '$Root'; npm run desktop"
)

Write-Host ""
Write-Host "Da migrate + mo API + Desktop. Health: http://localhost:5088/health" -ForegroundColor Green
Write-Host "Login: admin@aitest.com / Admin@123" -ForegroundColor Green
Write-Host ""
Write-Host "IDE bridge (Unit/E2E Gen):" -ForegroundColor Yellow
Write-Host "  npm run extension:install"
Write-Host "  Reload Window → status bar AITest :port"
Write-Host "  %USERPROFILE%\.aitest\ide-bridge.json"
