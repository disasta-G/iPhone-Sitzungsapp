# GGT PWA Deploy Script
# Usage:
#   .\deploy.ps1              # deployed beides (frontend + backend)
#   .\deploy.ps1 -Frontend    # nur frontend (index.html)
#   .\deploy.ps1 -Backend     # nur backend (server.js) + pm2 restart
#   .\deploy.ps1 -Logs        # zeigt aktuelle pm2 logs
#   .\deploy.ps1 -SSH         # öffnet interaktive SSH-Session

param(
    [switch]$Frontend,
    [switch]$Backend,
    [switch]$Logs,
    [switch]$SSH,
    [string]$Host = "root@76.13.153.12",
    [string]$LocalRoot = "$PSScriptRoot\.."
)

$ErrorActionPreference = "Stop"

# Farben
function Write-Step  { param($m) Write-Host "→ $m" -ForegroundColor Cyan }
function Write-Ok    { param($m) Write-Host "✓ $m" -ForegroundColor Green }
function Write-Warn  { param($m) Write-Host "⚠ $m" -ForegroundColor Yellow }
function Write-Err   { param($m) Write-Host "✗ $m" -ForegroundColor Red }

# --- Interaktive SSH-Session ---
if ($SSH) {
    Write-Step "Öffne SSH-Session zu $Host"
    ssh $Host
    exit
}

# --- Logs anzeigen ---
if ($Logs) {
    Write-Step "Hole aktuelle Logs von $Host"
    ssh $Host "pm2 logs ggt --lines 30 --nostream"
    exit
}

# Wenn weder -Frontend noch -Backend → beides
$deployFrontend = $Frontend -or (-not $Frontend -and -not $Backend)
$deployBackend  = $Backend  -or (-not $Frontend -and -not $Backend)

$indexLocal  = Join-Path $LocalRoot "index.html"
$serverLocal = Join-Path $LocalRoot "server.js"

# --- Frontend deployen ---
if ($deployFrontend) {
    if (-not (Test-Path $indexLocal)) {
        Write-Err "index.html nicht gefunden: $indexLocal"
        exit 1
    }
    Write-Step "Deploye Frontend (index.html)"
    scp $indexLocal "${Host}:/var/www/ggt/index.html"
    if ($LASTEXITCODE -ne 0) { Write-Err "scp fehlgeschlagen"; exit 1 }
    ssh $Host "chown www-data:www-data /var/www/ggt/index.html"
    Write-Ok "Frontend deployed"
}

# --- Backend deployen ---
if ($deployBackend) {
    if (-not (Test-Path $serverLocal)) {
        Write-Err "server.js nicht gefunden: $serverLocal"
        exit 1
    }
    Write-Step "Syntax-Check server.js lokal"
    $nodeCheck = node -c $serverLocal 2>&1
    if ($LASTEXITCODE -ne 0) {
        Write-Err "Syntax-Fehler in server.js:"
        Write-Host $nodeCheck
        exit 1
    }
    Write-Ok "Syntax OK"
    
    Write-Step "Deploye Backend (server.js)"
    scp $serverLocal "${Host}:/root/ggt-app/server.js"
    if ($LASTEXITCODE -ne 0) { Write-Err "scp fehlgeschlagen"; exit 1 }
    
    Write-Step "Restart PM2"
    ssh $Host "pm2 restart ggt"
    
    Write-Step "Warte 2s und hole Logs"
    Start-Sleep -Seconds 2
    ssh $Host "pm2 logs ggt --lines 8 --nostream"
    Write-Ok "Backend deployed"
}

Write-Host ""
Write-Ok "Fertig. Teste: https://ggt.plandiff.cloud"
