# ============================================================
# Nori Code — one-command installer (Windows)
# ============================================================
# Usage: powershell -ExecutionPolicy Bypass -File install.ps1
#    or: irm https://your-cdn/nori-code/install.ps1 | iex

param(
    [string]$NoriHome = "$env:USERPROFILE\.nori-code",
    [string]$Repo = "https://github.com/wangyuahn/nori-code.git"
)

$ErrorActionPreference = "Stop"

Write-Host "╔══════════════════════════════════════╗" -ForegroundColor Cyan
Write-Host "║       Nori Code Installer           ║" -ForegroundColor Cyan
Write-Host "╚══════════════════════════════════════╝" -ForegroundColor Cyan
Write-Host ""

# ---- check Node.js ----
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
    Write-Host "Node.js is required but not found." -ForegroundColor Red
    Write-Host "Install Node.js >= 24.15.0 from https://nodejs.org"
    exit 1
}
$nodeVersion = (node -v).Replace("v", "").Split(".")[0]
if ([int]$nodeVersion -lt 24) {
    Write-Host "Node.js >= 24.15.0 required. Current: $(node -v)" -ForegroundColor Red
    exit 1
}
Write-Host "✓ Node.js $(node -v)" -ForegroundColor Green

# ---- check pnpm ----
$pnpm = Get-Command pnpm -ErrorAction SilentlyContinue
if (-not $pnpm) {
    Write-Host "Installing pnpm..."
    npm install -g pnpm
}
Write-Host "✓ pnpm $(pnpm -v)" -ForegroundColor Green

# ---- check git ----
$git = Get-Command git -ErrorAction SilentlyContinue
if (-not $git) {
    Write-Host "Git is required. Install from https://gitforwindows.org" -ForegroundColor Red
    exit 1
}
Write-Host "✓ git" -ForegroundColor Green

# ---- clone / update ----
if (Test-Path "$NoriHome\.git") {
    Write-Host "Updating nori-code..."
    Set-Location $NoriHome
    git pull --ff-only
} else {
    Write-Host "Cloning nori-code into $NoriHome..."
    git clone $Repo $NoriHome
    Set-Location $NoriHome
}

# ---- install & build ----
Write-Host "Installing dependencies..."
pnpm install --frozen-lockfile 2>$null
if ($LASTEXITCODE -ne 0) { pnpm install }

Write-Host "Building..."
pnpm -C apps/nori-code run build

# ---- create nori.bat in PATH ----
$batPath = "$NoriHome\nori.bat"
$dist = "$NoriHome\apps\nori-code\dist\main.mjs"
@"
@echo off
node "$dist" %*
"@ | Out-File -FilePath $batPath -Encoding ASCII

# ---- add to user PATH ----
$currentPath = [Environment]::GetEnvironmentVariable("Path", "User")
if ($currentPath -notlike "*$NoriHome*") {
    [Environment]::SetEnvironmentVariable("Path", "$currentPath;$NoriHome", "User")
    $env:Path += ";$NoriHome"
    Write-Host "Added $NoriHome to PATH" -ForegroundColor Green
}

Write-Host ""
Write-Host "╔══════════════════════════════════════╗" -ForegroundColor Green
Write-Host "║   Nori Code installed!              ║" -ForegroundColor Green
Write-Host "║   Open a NEW terminal and run:      ║" -ForegroundColor Green
Write-Host "║   nori                              ║" -ForegroundColor Green
Write-Host "╚══════════════════════════════════════╝" -ForegroundColor Green
