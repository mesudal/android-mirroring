$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$version = '1.2.0'
$expectedExeHash = '4322d1acc103ed4ee6b62a2567bdb94dab8ace765157ca3e5d5a4646ae9432b8'
$expectedSourceHash = '6728ec4b60361c486594d8db988cb7787b32b185b1ba59ca37cbb4720cf895e9'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$destination = Join-Path $root 'build-assets\mirros'
New-Item -ItemType Directory -Path $destination -Force | Out-Null

function Get-VerifiedAsset($asset, $target, $pinnedHash) {
    if (-not $asset.digest -or $asset.digest -notmatch '^sha256:([0-9a-fA-F]{64})$') {
        throw "GitHub release asset has no valid SHA-256 digest: $($asset.name)"
    }

    $expectedHash = $Matches[1].ToLowerInvariant()
    if ($expectedHash -ne $pinnedHash) {
        throw "The published digest does not match the pinned MirrOS $version asset: $($asset.name)"
    }

    if (Test-Path -LiteralPath $target) {
        $existingHash = (Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($existingHash -eq $expectedHash) { return }
    }

    $temporary = "$target.download-$([Guid]::NewGuid().ToString('N'))"
    try {
        Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $temporary -Headers @{
            'User-Agent' = 'DroidBridge-Windows-Build'
        }
        $actualHash = (Get-FileHash -LiteralPath $temporary -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($actualHash -ne $expectedHash) {
            throw "SHA-256 verification failed for $($asset.name)"
        }
        Move-Item -LiteralPath $temporary -Destination $target -Force
        Write-Host "[OK] Verified $($asset.name)"
    } finally {
        if (Test-Path -LiteralPath $temporary) {
            Remove-Item -LiteralPath $temporary -Force
        }
    }
}

$release = Invoke-RestMethod `
    -Uri "https://api.github.com/repos/Cristiant2608/mirros/releases/tags/v$version" `
    -Headers @{ 'User-Agent' = 'DroidBridge-Windows-Build'; Accept = 'application/vnd.github+json' }

if ($release.draft -or $release.prerelease -or $release.tag_name -ne "v$version") {
    throw "MirrOS v$version is not a stable release."
}

$windowsAsset = $release.assets | Where-Object { $_.name -eq "Mirros-$version-Windows.exe" } | Select-Object -First 1
$sourceAsset = $release.assets | Where-Object { $_.name -eq "Mirros-$version-Source.zip" } | Select-Object -First 1
if (-not $windowsAsset -or -not $sourceAsset) {
    throw "MirrOS $version Windows binary or matching source archive was not found."
}

Get-VerifiedAsset $windowsAsset (Join-Path $destination 'MirrOS.exe') $expectedExeHash
Get-VerifiedAsset $sourceAsset (Join-Path $destination 'MirrOS-Source.zip') $expectedSourceHash
Write-Host "[OK] MirrOS $version is ready for Windows packaging."
