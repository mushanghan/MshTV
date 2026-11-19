param(
    [ValidatePattern('^\d+\.\d+\.\d+$')][string]$Version = '0.9.4',
    [string]$Compiler,
    [string]$MediaKit,
    [switch]$TestPackage
)
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
Set-Location $root
$env:DOTNET_CLI_TELEMETRY_OPTOUT = '1'
$sdk = Join-Path $root '.tools/dotnet/dotnet.exe'
if (-not (Test-Path -LiteralPath $sdk -PathType Leaf)) { $sdk = (Get-Command dotnet).Source }
if (-not $Compiler) {
    $candidates = @(
        "$env:LOCALAPPDATA\Programs\Inno Setup 6\ISCC.exe",
        "${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe",
        (Get-Command ISCC.exe -ErrorAction SilentlyContinue).Source)
    $Compiler = $candidates | Where-Object { $_ -and (Test-Path -LiteralPath $_ -PathType Leaf) } | Select-Object -First 1
}
if (-not $Compiler) { throw 'Install Inno Setup 6.7.3 and supply -Compiler with its ISCC.exe path.' }
$mediaNoticeFiles = @('README.txt', 'FFmpeg-LGPL-2.1.txt', 'FFmpeg-LICENSE.md', 'libwebp-LICENSE', 'libwebp-PATENTS',
    'zlib-LICENSE', 'dav1d-COPYING', 'MinGW-w64-runtime.txt')

if ($MediaKit) {
    $MediaKit = (Resolve-Path -LiteralPath $MediaKit).Path
    $mediaLock = Join-Path $root 'tools/ffmpeg/windows-media.lock.json'
    $media = Get-Content -LiteralPath $mediaLock -Raw | ConvertFrom-Json
    foreach ($name in 'ffmpeg', 'ffprobe') {
        $file = Join-Path $MediaKit "$name.exe"
        if (!(Test-Path -LiteralPath $file -PathType Leaf) -or (Get-FileHash -LiteralPath $file).Hash -ne $media.sha256.$name) {
            throw "Bundled $name does not match the Windows media lock."
        }
    }
    foreach ($notice in $mediaNoticeFiles) {
        if (!(Test-Path -LiteralPath (Join-Path $MediaKit "licenses/$notice") -PathType Leaf)) {
            throw "The media kit is missing $notice."
        }
    }
}

$build = Join-Path $root ('.data/windows-' + [Guid]::NewGuid().ToString('N'))
$payload = Join-Path $build 'payload'
$backend = Join-Path $payload 'server'
$result = Join-Path $root 'dist/windows'
if ($TestPackage) { $result = Join-Path $build 'test-setup' }
New-Item -ItemType Directory -Force $payload, $result | Out-Null

Push-Location (Join-Path $root 'apps/web')
try {
    if (-not (Test-Path node_modules)) { & npm.cmd ci; if ($LASTEXITCODE) { throw 'npm ci failed' } }
    & npm.cmd run build
    if ($LASTEXITCODE) { throw 'WebUI build failed' }
} finally { Pop-Location }

& $sdk publish src/MshTV.Launcher/MshTV.Launcher.csproj -r win-x64 --self-contained -c Release -o $payload "-p:Version=$Version" -p:DebugType=None -p:DebugSymbols=false -p:RestoreLockedMode=true
if ($LASTEXITCODE) { throw 'Launcher publish failed' }
& $sdk publish src/MshTV.Server/MshTV.Server.csproj -r win-x64 --self-contained -c Release -o $backend "-p:Version=$Version" -p:DebugType=None -p:DebugSymbols=false -p:RestoreLockedMode=true
if ($LASTEXITCODE) { throw 'Backend publish failed' }
# Publish uses the fresh Vite output. Only this newly created, verified staging directory may be replaced.
$publishedWeb = [IO.Path]::GetFullPath((Join-Path $backend 'wwwroot'))
if (-not $publishedWeb.StartsWith([IO.Path]::GetFullPath($payload) + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Unexpected staging directory'
}
if (Test-Path -LiteralPath $publishedWeb) { Remove-Item -LiteralPath $publishedWeb -Recurse -Force }
Copy-Item -LiteralPath (Join-Path $root 'apps/web/dist') -Destination $publishedWeb -Recurse
if ($MediaKit) {
    $mediaOutput = Join-Path $backend 'media-tools'
    $mediaNotices = Join-Path $payload 'licenses/ffmpeg'
    New-Item -ItemType Directory -Path $mediaOutput, $mediaNotices | Out-Null
    Copy-Item -LiteralPath (Join-Path $MediaKit 'ffmpeg.exe'), (Join-Path $MediaKit 'ffprobe.exe') -Destination $mediaOutput
    Copy-Item -LiteralPath $mediaLock -Destination (Join-Path $backend 'media-tools.lock.json') -Force
    foreach ($notice in $mediaNoticeFiles) {
        Copy-Item -LiteralPath (Join-Path $MediaKit "licenses/$notice") -Destination $mediaNotices
    }
}
& node.exe tools/windows-notices.mjs $payload
if ($LASTEXITCODE) { throw 'License inventory failed' }
Copy-Item -LiteralPath (Join-Path (Split-Path -Parent $Compiler) 'license.txt') -Destination (Join-Path $payload 'licenses/Inno-Setup.txt')

$lines = Get-ChildItem -LiteralPath $payload -Recurse -File | Sort-Object FullName | ForEach-Object {
    $relative = $_.FullName.Substring($payload.Length + 1)
    (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash + '  ' + $relative
}
Set-Content -LiteralPath (Join-Path $payload 'payload.sha256') -Value $lines -Encoding UTF8
$product = if ($TestPackage) { 'MshTV-QA' } else { 'MshTV' }
& $Compiler /Qp "/DProductKey=$product" "/DProductVersion=$Version" "/DPayload=$payload" "/O$result" 'installer/MshTV.iss'
if ($LASTEXITCODE) { throw 'Installer compilation failed' }
$installer = Join-Path $result "$product-Setup-$Version-win-x64.exe"
$hash = (Get-FileHash -LiteralPath $installer -Algorithm SHA256).Hash
Set-Content -LiteralPath "$installer.sha256" -Value "$hash  $(Split-Path $installer -Leaf)" -Encoding ascii
Write-Output $installer
