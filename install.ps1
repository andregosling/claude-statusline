# claude-statusline installer (Windows)
# Usage: irm https://raw.githubusercontent.com/andregosling/claude-statusline/main/install.ps1 | iex

$ErrorActionPreference = 'Stop'

$REPO_RAW = 'https://raw.githubusercontent.com/andregosling/claude-statusline/main'
$ClaudeDir = Join-Path $HOME '.claude'
$Settings  = Join-Path $ClaudeDir 'settings.json'
$Renderer  = Join-Path $ClaudeDir 'statusline.js'
$BinDir    = Join-Path $HOME '.claude\bin'
$Cli       = Join-Path $BinDir 'claude-statusline.cmd'
$CliJs     = Join-Path $BinDir 'claude-statusline.js'

function Ok($m)   { Write-Host "✓ $m" -ForegroundColor Green }
function Warn($m) { Write-Host "! $m" -ForegroundColor Yellow }
function Err($m)  { Write-Host "✗ $m" -ForegroundColor Red }
function Info($m) { Write-Host "→ $m" -ForegroundColor DarkGray }

# Force UTF-8 output so emoji / box drawing renders right
[Console]::OutputEncoding = [Text.Encoding]::UTF8

# Preflight
$node = (Get-Command node -ErrorAction SilentlyContinue)
if (-not $node) {
  Err "node is required. Install Node.js or make sure it's on PATH."
  Err "Claude Code ships its own Node — if you have CC installed, find node.exe in its install dir."
  exit 1
}
$NodeBin = $node.Source

if (-not (Test-Path $ClaudeDir)) {
  Err "$ClaudeDir does not exist. Install Claude Code first."
  exit 1
}

# Download renderer
Info "downloading statusline.js"
Invoke-WebRequest -Uri "$REPO_RAW/statusline.js" -OutFile $Renderer -UseBasicParsing
Ok "installed $Renderer"

# Download CLI + create a .cmd shim that runs it via node
New-Item -ItemType Directory -Force -Path $BinDir | Out-Null
Info "installing claude-statusline CLI"
Invoke-WebRequest -Uri "$REPO_RAW/bin/claude-statusline.js" -OutFile $CliJs -UseBasicParsing
@"
@echo off
"$NodeBin" "$CliJs" %*
"@ | Set-Content -Path $Cli -Encoding ASCII
Ok "installed $Cli"

# Patch settings.json
if (Test-Path $Settings) {
  $bak = "$Settings.bak.$([int][double]::Parse((Get-Date -UFormat %s)))"
  Copy-Item $Settings $bak
  Info "backed up existing settings.json → $bak"
  $settingsObj = Get-Content $Settings -Raw | ConvertFrom-Json
} else {
  $settingsObj = [PSCustomObject]@{}
}

# Build statusLine object — use forward slashes in the renderer path, Windows accepts them
$NodeBinFwd = $NodeBin -replace '\\','/'
$RendererFwd = $Renderer -replace '\\','/'
$cmdStr = '"' + $NodeBinFwd + '" "' + $RendererFwd + '"'

$statusLine = [PSCustomObject]@{
  type            = 'command'
  command         = $cmdStr
  padding         = 1
  refreshInterval = 5
}

if ($settingsObj.PSObject.Properties.Name -contains 'statusLine') {
  $settingsObj.statusLine = $statusLine
} else {
  $settingsObj | Add-Member -NotePropertyName statusLine -NotePropertyValue $statusLine -Force
}

$settingsObj | ConvertTo-Json -Depth 100 | Set-Content -Path $Settings -Encoding UTF8
Ok "patched $Settings"

# PATH check for the CLI
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if ($userPath -notlike "*$BinDir*") {
  Warn "$BinDir is not on your user PATH"
  Info "Run this in PowerShell to add it permanently:"
  Info "    [Environment]::SetEnvironmentVariable('Path', `"`$([Environment]::GetEnvironmentVariable('Path','User'));$BinDir`", 'User')"
  Info "Or invoke the CLI by full path: $Cli"
}

# Nerd Font check
$nerdInstalled = $false
$fontDirs = @("$env:WINDIR\Fonts", "$env:LOCALAPPDATA\Microsoft\Windows\Fonts")
foreach ($d in $fontDirs) {
  if (Test-Path $d) {
    if ((Get-ChildItem $d -ErrorAction SilentlyContinue | Where-Object { $_.Name -match '(?i)nerd' }).Count -gt 0) {
      $nerdInstalled = $true; break
    }
  }
}
if ($nerdInstalled) {
  Ok "Nerd Font detected"
} else {
  Warn "no Nerd Font detected — icons will render as boxes (□)"
  Info "Recommended: scoop install JetBrainsMono-NF"
  Info "Or: winget install --id=DEVCOM.JetBrainsMonoNerdFont"
  Info "Or download from https://www.nerdfonts.com/font-downloads"
  Info "After installing, set your terminal font to 'JetBrainsMono Nerd Font'."
  Info "Or set CLAUDE_STATUSLINE_PLAIN=1 in your env to use ASCII fallbacks."
}

Write-Host ""
Ok "done. reload Claude Code (or wait ~5s) to see the new status line."
Info "updates check automatically every 24h. Force now: claude-statusline update"
