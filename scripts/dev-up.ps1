#Requires -Version 5.1
<#
.SYNOPSIS
  Khoi dong stack AITest: Postgres + API + Desktop (Tauri).
.EXAMPLE
  npm run up
  pwsh -File ./scripts/dev-up.ps1
#>
$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
if (-not $Root) { $Root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path }
Set-Location $Root

Write-Host "=== 1) Postgres ===" -ForegroundColor Cyan
npm run db
Start-Sleep -Seconds 2

Write-Host "=== 2) API (cua so moi) ===" -ForegroundColor Cyan
Start-Process powershell -ArgumentList @(
  "-NoProfile", "-ExecutionPolicy", "Bypass",
  "-NoExit", "-Command",
  "Set-Location '$Root'; npm run start"
)

Write-Host "=== 3) Desktop Tauri (cua so moi) ===" -ForegroundColor Cyan
Start-Process powershell -ArgumentList @(
  "-NoProfile", "-ExecutionPolicy", "Bypass",
  "-NoExit", "-Command",
  "Set-Location '$Root'; npm run desktop"
)

Write-Host ""
Write-Host "Da mo API + Desktop. Health: http://localhost:5088/health" -ForegroundColor Green
Write-Host ""
Write-Host "IDE bridge (bat buoc de Connect IDE):" -ForegroundColor Yellow
Write-Host "  npm run extension:install   # cai vao Cursor/VS Code"
Write-Host "  Roi: Reload Window → status bar 'AITest :port'"
Write-Host "  File: %USERPROFILE%\.aitest\ide-bridge.json"
Write-Host "  (Dev nhanh: F5 trong ide-plugins/vscode, hoac npm run mock-ide)"
