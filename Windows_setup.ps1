# DroidBridge setup helper (PowerShell)
# adb / scrcpy auto download — ASCII English safe
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root
$bin = Join-Path $root 'bin'
if (-not (Test-Path $bin)) { New-Item -ItemType Directory -Path $bin | Out-Null }

function Step($msg) { Write-Host "[..] $msg" -ForegroundColor Yellow }
function Ok($msg)   { Write-Host "[OK] $msg" -ForegroundColor Green }
function Fail($msg) { Write-Host "[X] $msg" -ForegroundColor Red }

# ── adb download ──────────────────────────────
if (Test-Path (Join-Path $bin 'adb.exe')) {
    Ok 'adb is ready'
} else {
    Step 'Downloading adb (platform-tools)...'
    $tmp = Join-Path $env:TEMP 'db_pt.zip'
    $ex  = Join-Path $env:TEMP 'db_pt'
    Invoke-WebRequest 'https://dl.google.com/android/repository/platform-tools-latest-windows.zip' -OutFile $tmp
    if (Test-Path $ex) { Remove-Item $ex -Recurse -Force }
    Expand-Archive $tmp -DestinationPath $ex -Force
    $pt = Join-Path $ex 'platform-tools'
    foreach ($f in @('adb.exe','AdbWinApi.dll','AdbWinUsbApi.dll')) {
        Copy-Item (Join-Path $pt $f) -Destination $bin -Force
    }
    Remove-Item $tmp,$ex -Recurse -Force
    if (Test-Path (Join-Path $bin 'adb.exe')) { Ok 'adb installed successfully' }
    else { Fail 'adb install failed'; exit 1 }
}

# ── scrcpy download ───────────────────────────
if (Test-Path (Join-Path $bin 'scrcpy.exe')) {
    Ok 'scrcpy is ready'
} else {
    Step 'Downloading latest scrcpy...'
    $tmp = Join-Path $env:TEMP 'db_scrcpy.zip'
    $ex  = Join-Path $env:TEMP 'db_scrcpy'
    $rel = Invoke-RestMethod 'https://api.github.com/repos/Genymobile/scrcpy/releases/latest'
    $asset = $rel.assets | Where-Object { $_.name -like 'scrcpy-win64-*.zip' } | Select-Object -First 1
    if (-not $asset) { Fail 'scrcpy release not found'; exit 1 }
    Invoke-WebRequest $asset.browser_download_url -OutFile $tmp
    if (Test-Path $ex) { Remove-Item $ex -Recurse -Force }
    Expand-Archive $tmp -DestinationPath $ex -Force
    $dir = Get-ChildItem $ex -Directory | Select-Object -First 1
    if (-not $dir) { $dir = Get-Item $ex }
    Copy-Item (Join-Path $dir.FullName '*') -Destination $bin -Recurse -Force
    Remove-Item $tmp,$ex -Recurse -Force
    if (Test-Path (Join-Path $bin 'scrcpy.exe')) { Ok 'scrcpy installed successfully' }
    else { Fail 'scrcpy install failed'; exit 1 }
}

Ok 'Binary setup complete'
exit 0
