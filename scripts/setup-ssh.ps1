# Einmaliges Setup für passwortloses SSH + SCP zum VPS
# Läuft auf Windows 10/11 mit OpenSSH (bei Windows 10 1809+ vorinstalliert)
# Ausführen als: .\setup-ssh.ps1

$ErrorActionPreference = "Stop"
$VpsHost = "root@76.13.153.12"
$SshDir  = "$env:USERPROFILE\.ssh"
$KeyPath = "$SshDir\ggt_vps_rsa"

Write-Host "→ Prüfe OpenSSH" -ForegroundColor Cyan
$sshInfo = Get-Command ssh -ErrorAction SilentlyContinue
if (-not $sshInfo) {
    Write-Host "✗ OpenSSH fehlt. Installiere via: Settings → Apps → Optional Features → OpenSSH Client" -ForegroundColor Red
    exit 1
}
Write-Host "✓ OpenSSH vorhanden: $($sshInfo.Source)" -ForegroundColor Green

# .ssh-Ordner sicherstellen
if (-not (Test-Path $SshDir)) {
    New-Item -ItemType Directory -Path $SshDir -Force | Out-Null
}

# Key erzeugen wenn noch nicht vorhanden
if (-not (Test-Path $KeyPath)) {
    Write-Host "→ Erzeuge neuen SSH-Key" -ForegroundColor Cyan
    ssh-keygen -t rsa -b 4096 -f $KeyPath -N '""' -C "ggt-deploy-$env:COMPUTERNAME"
    Write-Host "✓ Key erzeugt: $KeyPath" -ForegroundColor Green
} else {
    Write-Host "✓ Key existiert bereits: $KeyPath" -ForegroundColor Green
}

# Public Key aufs VPS kopieren
Write-Host "→ Kopiere Public Key zum VPS (Passwort für root eingeben)" -ForegroundColor Cyan
$pubKey = Get-Content "$KeyPath.pub"
ssh $VpsHost "mkdir -p ~/.ssh && echo '$pubKey' >> ~/.ssh/authorized_keys && chmod 700 ~/.ssh && chmod 600 ~/.ssh/authorized_keys && sort -u ~/.ssh/authorized_keys -o ~/.ssh/authorized_keys"

if ($LASTEXITCODE -ne 0) {
    Write-Host "✗ Konnte Public Key nicht kopieren" -ForegroundColor Red
    exit 1
}

# SSH-Config erstellen oder erweitern (damit man nur `ssh ggt` tippen muss)
$SshConfig = "$SshDir\config"
$configEntry = @"

Host ggt
    HostName 76.13.153.12
    User root
    IdentityFile ~/.ssh/ggt_vps_rsa
    IdentitiesOnly yes
"@

$existing = if (Test-Path $SshConfig) { Get-Content $SshConfig -Raw } else { "" }
if ($existing -notmatch "Host ggt") {
    Add-Content -Path $SshConfig -Value $configEntry
    Write-Host "✓ ~/.ssh/config: Host-Alias 'ggt' angelegt" -ForegroundColor Green
} else {
    Write-Host "✓ ~/.ssh/config: 'ggt' bereits vorhanden" -ForegroundColor Green
}

# Test
Write-Host "→ Test: SSH-Verbindung ohne Passwort" -ForegroundColor Cyan
$test = ssh -o BatchMode=yes -o ConnectTimeout=5 ggt "echo OK" 2>&1
if ($test -match "OK") {
    Write-Host "✓ Passwortloses SSH funktioniert: ssh ggt" -ForegroundColor Green
} else {
    Write-Host "⚠ Test fehlgeschlagen: $test" -ForegroundColor Yellow
}

Write-Host ""
Write-Host "Fertig. Ab jetzt kannst du:" -ForegroundColor Green
Write-Host "  ssh ggt             # Login ohne Passwort"
Write-Host "  .\deploy.ps1        # Deploy beides"
Write-Host "  .\deploy.ps1 -Logs  # pm2 logs anzeigen"
