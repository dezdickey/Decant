# Decant launcher for Windows.
#
# Starts rclone's remote-control server on this computer only (127.0.0.1),
# protected by a password made fresh for this launch, then opens the UI.
# If a server from an earlier launch is still running, it is reused, so
# an upload in progress is never interrupted by opening Decant again.

param(
    # Start (or find) the server but do not open a browser tab.
    [switch]$NoOpen
)

$ErrorActionPreference = 'Stop'
$root        = $PSScriptRoot
$ui          = Join-Path $root 'ui'
$sessionFile = Join-Path $ui 'session.js'
$logDir      = Join-Path $root 'logs'
$logFile     = Join-Path $logDir 'rclone.log'
$page        = Join-Path $ui 'index.html'

function Find-Rclone {
    $cmd = Get-Command rclone -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    # A shell opened before rclone was installed has a stale PATH, so look
    # where the usual installers put it.
    $winget = Join-Path $env:LOCALAPPDATA 'Microsoft\WinGet\Packages'
    $places = @()
    if (Test-Path $winget) { $places += Get-ChildItem $winget -Directory -Filter 'Rclone.Rclone_*' | ForEach-Object FullName }
    $places += (Join-Path $env:USERPROFILE 'scoop\apps\rclone\current')
    $places += 'C:\ProgramData\chocolatey\lib\rclone'
    $places += (Join-Path $env:ProgramFiles 'rclone')
    foreach ($dir in $places) {
        if (Test-Path $dir) {
            $hit = Get-ChildItem $dir -Recurse -Filter rclone.exe -ErrorAction SilentlyContinue | Select-Object -First 1
            if ($hit) { return $hit.FullName }
        }
    }
    return $null
}

function Read-Session {
    if (-not (Test-Path $sessionFile)) { return $null }
    $text = Get-Content $sessionFile -Raw
    if ($text -notmatch '\{.*\}') { return $null }
    try { return $Matches[0] | ConvertFrom-Json } catch { return $null }
}

function Test-Session($s) {
    if (-not $s) { return $false }
    $pair = [Text.Encoding]::UTF8.GetBytes("$($s.user):$($s.pass)")
    $headers = @{ Authorization = 'Basic ' + [Convert]::ToBase64String($pair) }
    try {
        $r = Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:$($s.port)/core/version" `
            -Headers $headers -ContentType 'application/json' -Body '{}' -TimeoutSec 2
        return [bool]$r.version
    } catch { return $false }
}

function Get-FreePort {
    foreach ($p in 5573..5599) {
        $listener = $null
        try {
            $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, $p)
            $listener.Start()
            return $p
        } catch {
        } finally {
            if ($listener) { $listener.Stop() }
        }
    }
    throw 'No free port between 5573 and 5599.'
}

function New-Secret {
    $bytes = New-Object byte[] 24
    [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
    return ([Convert]::ToBase64String($bytes) -replace '[+/=]', '')
}

# Reuse a server that is already up, so a running upload carries on.
$existing = Read-Session
if (Test-Session $existing) {
    if (-not $NoOpen) { Start-Process $page }
    exit 0
}

$rclone = Find-Rclone
if (-not $rclone) {
    Write-Host ''
    Write-Host 'Decant needs rclone, and it is not installed.' -ForegroundColor Yellow
    Write-Host 'Install it with:   winget install Rclone.Rclone'
    Write-Host 'then connect your cloud once with:   rclone config'
    Write-Host 'More at https://rclone.org/install/'
    exit 1
}

New-Item -ItemType Directory -Force $logDir | Out-Null
$port = Get-FreePort
$session = [ordered]@{ port = $port; user = 'decant'; pass = (New-Secret) }

# The password goes to rclone through the environment rather than the
# command line, where any program could read it from the process list.
$env:RCLONE_RC_USER = $session.user
$env:RCLONE_RC_PASS = $session.pass
$rcArgs = @(
    'rcd',
    '--rc-addr', "127.0.0.1:$port",
    # The page is opened from disk, and browsers give file:// pages the
    # origin "null". The password still guards every request.
    '--rc-allow-origin', 'null',
    # Keep finished jobs long enough for a reopened page to show the result.
    '--rc-job-expire-duration', '24h',
    '--log-file', "`"$logFile`"",
    '--log-level', 'INFO'
) -join ' '
$proc = Start-Process -FilePath $rclone -ArgumentList $rcArgs -WindowStyle Hidden -PassThru
Remove-Item Env:RCLONE_RC_PASS, Env:RCLONE_RC_USER

$json = $session | ConvertTo-Json -Compress
Set-Content -Path $sessionFile -Encoding UTF8 -Value @(
    '// Written by the launcher. Holds the password to the local server for this',
    '// run only: it is replaced on every launch and is never committed.',
    "window.DECANT_SESSION = $json;"
)

$s = [pscustomobject]$session
for ($i = 0; $i -lt 40; $i++) {
    if (Test-Session $s) { if (-not $NoOpen) { Start-Process $page }; exit 0 }
    if ($proc.HasExited) { break }
    Start-Sleep -Milliseconds 250
}

Write-Host 'rclone did not start. The end of its log:' -ForegroundColor Yellow
if (Test-Path $logFile) { Get-Content $logFile -Tail 15 }
exit 1
