#Requires -Version 5.1
<#
.SYNOPSIS
  Compile AITest IDE extensions and install into the matching editor folders.
.EXAMPLE
  npm run extension:install
  pwsh -File ./scripts/install-ide-extension.ps1
#>
$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
if (-not $Root) { $Root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path }

function Ensure-Dir([string]$Path) {
  if (-not (Test-Path $Path)) {
    New-Item -ItemType Directory -Path $Path -Force | Out-Null
  }
}

function Compile-Extension {
  param([string]$TargetDir, [string]$PluginLabel)

  Write-Host "=== Compiling $PluginLabel ($TargetDir) ===" -ForegroundColor Cyan
  if (-not (Test-Path $TargetDir)) {
    throw "Missing plugin folder: $TargetDir"
  }
  Push-Location $TargetDir
  try {
    if (-not (Test-Path (Join-Path $TargetDir "node_modules"))) {
      npm install
    } else {
      Write-Host "node_modules OK"
    }
    npm run compile
  } finally {
    Pop-Location
  }
  if (-not (Test-Path (Join-Path $TargetDir "out\extension.js"))) {
    throw "Compile failed for ${PluginLabel}: out/extension.js missing"
  }
}

function Install-ExtensionTo {
  param(
    [string]$TargetDir,
    [string]$PluginLabel,
    [string]$ExtensionsRoot,
    [string]$Label,
    [switch]$CreateIfMissing
  )

  if (-not (Test-Path $ExtensionsRoot)) {
    if ($CreateIfMissing) {
      Ensure-Dir $ExtensionsRoot
      Write-Host "Created $Label extensions folder: $ExtensionsRoot" -ForegroundColor DarkCyan
    } else {
      Write-Host "Skip $Label (folder missing): $ExtensionsRoot" -ForegroundColor Yellow
      return $false
    }
  }

  $pkg = Get-Content (Join-Path $TargetDir "package.json") -Raw | ConvertFrom-Json
  $folderName = "$($pkg.publisher).$($pkg.name)-$($pkg.version)"
  $dest = Join-Path $ExtensionsRoot $folderName
  if (Test-Path $dest) {
    Remove-Item -Recurse -Force $dest
  }
  New-Item -ItemType Directory -Path $dest -Force | Out-Null
  Copy-Item (Join-Path $TargetDir "package.json") $dest
  Copy-Item (Join-Path $TargetDir "out") $dest -Recurse
  if (Test-Path (Join-Path $TargetDir "README.md")) {
    Copy-Item (Join-Path $TargetDir "README.md") $dest
  }
  Write-Host "Installed $PluginLabel -> $Label ($dest)" -ForegroundColor Green
  return $true
}

$vscodeDir = Join-Path $Root "ide-plugins\vscode"
$antigravityDir = Join-Path $Root "ide-plugins\antigravity"

Compile-Extension $vscodeDir "VS Code / Cursor Plugin"
$okVs =
  (Install-ExtensionTo $vscodeDir "VS Code / Cursor Plugin" (Join-Path $env:USERPROFILE ".cursor\extensions") "Cursor") -or
  (Install-ExtensionTo $vscodeDir "VS Code / Cursor Plugin" (Join-Path $env:USERPROFILE ".vscode\extensions") "VS Code")

$okAg = $false
if (Test-Path $antigravityDir) {
  Compile-Extension $antigravityDir "Antigravity Plugin"
  # Antigravity IDE uses VS Code-compatible extension folders under these roots.
  $agRoots = @(
    (Join-Path $env:USERPROFILE ".gemini\antigravity-ide\extensions"),
    (Join-Path $env:USERPROFILE ".antigravity\extensions"),
    (Join-Path $env:USERPROFILE ".antigravity-ide\extensions"),
    (Join-Path $env:APPDATA "Antigravity\User\extensions"),
    (Join-Path $env:APPDATA "Gemini Antigravity\User\extensions")
  )
  foreach ($root in $agRoots) {
    $installed = Install-ExtensionTo $antigravityDir "Antigravity Plugin" $root "Antigravity IDE" -CreateIfMissing
    if ($installed) { $okAg = $true }
  }
}

Write-Host ""
Write-Host "=== Next steps ===" -ForegroundColor Cyan
Write-Host "1. Reload IDE (Antigravity / Cursor / VS Code): Command Palette -> Developer: Reload Window"
Write-Host "2. Status bar should show 'AITest :port' (Cursor) or 'AITest (Antigravity) :port'"
Write-Host "   Or run: AITest: Start IDE Bridge"
Write-Host "3. Confirm discovery file:"
Write-Host "   $($env:USERPROFILE)\.aitest\ide-bridge.json  (ide field = antigravity | cursor | vscode)"
Write-Host "4. Desktop: npm run desktop → Unit test → Connect IDE"
Write-Host ""
if (-not $okVs -and -not $okAg) {
  Write-Host "No editor extensions folder found. Package VSIX instead:" -ForegroundColor Yellow
  Write-Host "  npm run extension:package"
  Write-Host "  npm run extension:antigravity:package"
  exit 1
}
