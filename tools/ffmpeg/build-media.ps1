param(
    [Parameter(Mandatory)][string]$Sources,
    [Parameter(Mandatory)][string]$Toolchain,
    [Parameter(Mandatory)][string]$WorkDirectory,
    [ValidateRange(1, 32)][int]$Jobs = 8
)

$ErrorActionPreference = 'Stop'
$Sources = (Resolve-Path -LiteralPath $Sources).Path
$Toolchain = (Resolve-Path -LiteralPath $Toolchain).Path
$WorkDirectory = [IO.Path]::GetFullPath($WorkDirectory)
if (Test-Path -LiteralPath $WorkDirectory) { throw 'Choose a new work directory for the media build.' }
if ($WorkDirectory -notmatch '^[A-Za-z]:[\\/][A-Za-z0-9_.\\/-]+$') { throw 'Use an ASCII media build path without spaces.' }

$archives = [ordered]@{
    'ffmpeg-9.0.2.tar.xz'     = '8C3850283EB25FA026482078A04051E0BE17347B09EF81A0849BEC15A96E002E'
    'libwebp-1.6.0.tar.gz'    = 'E4AB7009BF0629FD11982D4C2AA83964CF244CFFBA7347ECD39019A9E38C4564'
    'zlib-1.4.tar.gz'        = '02DD159783677A749C04ADBDD02B55B8A2BCC7E054F51B76B549199A916AD584'
    'dav1d-1.5.3.tar.xz'     = '732010AA5EF461FA93355ED2C6C5FEDB48DDC4B74E697EAABE8907EAEB943011'
}
function Invoke-MediaBuild([string]$Command, [string[]]$Arguments, [string]$Log) {
    & $Command @Arguments *>> $Log
    if ($LASTEXITCODE -ne 0) { Get-Content -LiteralPath $Log -Tail 30; throw "Media build failed in $Command. See $Log." }
}

New-Item -ItemType Directory -Path $WorkDirectory | Out-Null
foreach ($name in $archives.Keys) {
    $file = Join-Path $Sources $name
    if ((Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash -ne $archives[$name]) { throw "Source archive checksum mismatch: $name" }
    & "$env:SystemRoot/System32/tar.exe" -xf $file -C $WorkDirectory
    if ($LASTEXITCODE -ne 0) { throw "Could not extract $name" }
}

$originalPath = $env:Path
$env:Path = (Join-Path $Toolchain 'bin') + ';' + $env:Path
$log = Join-Path $WorkDirectory 'build.log'
$prefix = (Join-Path $WorkDirectory 'prefix').Replace('\', '/')
New-Item -ItemType Directory -Path "$prefix/lib", "$prefix/include" -Force | Out-Null
Push-Location -LiteralPath $WorkDirectory
try {
    Write-Host 'Building zlib and libwebp'
    Invoke-MediaBuild sh.exe @('-c', "cd zlib-1.4 && make -f win32/Makefile.gcc -j$Jobs libz.a") $log
    Copy-Item -LiteralPath 'zlib-1.4/libz.a' -Destination "$prefix/lib/"
    Copy-Item -LiteralPath 'zlib-1.4/zlib.h', 'zlib-1.4/zconf.h' -Destination "$prefix/include/"
    Invoke-MediaBuild cmake.exe @('-S','libwebp-1.6.0','-B','webp-build','-G','MinGW Makefiles',
        '-DCMAKE_BUILD_TYPE=Release',"-DCMAKE_INSTALL_PREFIX=$prefix",'-DBUILD_SHARED_LIBS=OFF',
        '-DWEBP_BUILD_ANIM_UTILS=OFF','-DWEBP_BUILD_CWEBP=OFF','-DWEBP_BUILD_DWEBP=OFF','-DWEBP_BUILD_GIF2WEBP=OFF',
        '-DWEBP_BUILD_IMG2WEBP=OFF','-DWEBP_BUILD_VWEBP=OFF','-DWEBP_BUILD_WEBPINFO=OFF','-DWEBP_BUILD_LIBWEBPMUX=OFF',
        '-DWEBP_BUILD_WEBPMUX=OFF','-DWEBP_BUILD_EXTRAS=OFF','-DWEBP_USE_THREAD=OFF') $log
    Invoke-MediaBuild cmake.exe @('--build','webp-build','--target','install','--parallel',"$Jobs") $log

    Write-Host 'Building dav1d'
    $mingwPath = $env:Path
    # Meson probes GNU patch even with downloads disabled. Prefer Git for Windows' GNU patch to BusyBox patch.
    $gitTools = Join-Path (Split-Path (Split-Path (Get-Command git.exe).Source)) 'usr/bin'
    $env:Path = $gitTools + ';' + $mingwPath
    try {
        Invoke-MediaBuild meson.exe @('setup','dav1d-build','dav1d-1.5.3','--wrap-mode=nodownload','--default-library=static',
            '--buildtype=release','--libdir=lib',"--prefix=$prefix",'-Denable_asm=false','-Denable_tools=false','-Denable_tests=false') $log
        Invoke-MediaBuild meson.exe @('compile','-C','dav1d-build','-j',"$Jobs") $log
        Invoke-MediaBuild meson.exe @('install','-C','dav1d-build','--no-rebuild') $log
    } finally { $env:Path = $mingwPath }

    Write-Host 'Building FFmpeg and ffprobe'
    $settings = @(
        '--target-os=mingw32','--arch=x86_64','--disable-autodetect','--disable-network','--disable-avdevice',
        '--disable-ffplay','--disable-doc','--disable-debug','--disable-x86asm','--disable-hwaccels',
        '--enable-libwebp','--enable-libdav1d','--enable-zlib','--pkg-config-flags=--static',
        '--disable-encoders','--enable-encoder=libwebp,pcm_s16le',
        '--disable-muxers','--enable-muxer=webp,pcm_s16le',
        '--disable-demuxers','--enable-demuxer=mov,matroska,avi,mpegps,mpegts,image_png_pipe,image_jpeg_pipe,image_webp_pipe,gif,image_bmp_pipe,image_tiff_pipe,mp3,wav,flac,aac,ogg,asf',
        '--disable-protocols','--enable-protocol=file,pipe',
        '--disable-filters','--enable-filter=aformat,anull,aresample,format,hflip,null,rotate,scale,transpose,vflip',
        '--extra-ldflags=-static','--extra-ldflags=-Wl,--no-insert-timestamp'
    )
    # Restrict pkg-config and C library searches to the dependencies just built.
    $arguments = $settings | ForEach-Object { "'$_'" }
    $configure = "cd ffmpeg-9.0.2 && export CPATH='$prefix/include' LIBRARY_PATH='$prefix/lib' PKG_CONFIG_LIBDIR='$prefix/lib/pkgconfig' PKG_CONFIG_PATH='' && sh ./configure " + ($arguments -join ' ')
    Invoke-MediaBuild sh.exe @('-c', $configure) $log
    Invoke-MediaBuild sh.exe @('-c', "cd ffmpeg-9.0.2 && make -j$Jobs ffmpeg.exe ffprobe.exe") $log

    $demuxers = & ./ffmpeg-9.0.2/ffprobe.exe -hide_banner -demuxers | Out-String
    $muxers = & ./ffmpeg-9.0.2/ffmpeg.exe -hide_banner -muxers | Out-String
    foreach ($name in 'png_pipe', 'jpeg_pipe', 'webp_pipe', 'bmp_pipe', 'tiff_pipe', 'matroska', 'mov', 'wav') {
        if ($demuxers -notmatch "\b$name\b") { throw "Media build is missing the $name demuxer." }
    }
    foreach ($name in 'webp', 's16le') {
        if ($muxers -notmatch "\b$name\b") { throw "Media build is missing the $name muxer." }
    }

    $kit = Join-Path $WorkDirectory 'media-kit'
    $licenses = Join-Path $kit 'licenses'
    New-Item -ItemType Directory -Path $licenses -Force | Out-Null
    Copy-Item -LiteralPath 'ffmpeg-9.0.2/ffmpeg.exe', 'ffmpeg-9.0.2/ffprobe.exe' -Destination $kit
    $notices = @{
        'FFmpeg-LGPL-2.1.txt' = 'ffmpeg-9.0.2/COPYING.LGPLv2.1'
        'FFmpeg-LICENSE.md' = 'ffmpeg-9.0.2/LICENSE.md'
        'libwebp-LICENSE' = 'libwebp-1.6.0/COPYING'
        'libwebp-PATENTS' = 'libwebp-1.6.0/PATENTS'
        'zlib-LICENSE' = 'zlib-1.4/LICENSE'
        'dav1d-COPYING' = 'dav1d-1.5.3/COPYING'
        'MinGW-w64-runtime.txt' = (Join-Path $Toolchain 'COPYING.MinGW-w64-runtime.txt')
    }
    foreach ($notice in $notices.Keys) { Copy-Item -LiteralPath $notices[$notice] -Destination (Join-Path $licenses $notice) }
    @'
FFmpeg 9.0.2 and ffprobe are separate executable tools used by MshTV.
This build is licensed under LGPL-2.1-or-later. License texts for FFmpeg
and bundled components are included in this directory.

The complete source archives and build script for this media build are
available with the Windows installer on GitHub Releases:
https://github.com/mushanghan/MshTV/releases/tag/v0.9.3

Build documentation: https://github.com/mushanghan/MshTV/blob/main/docs/FFMPEG.md
'@ | Set-Content -LiteralPath (Join-Path $licenses 'README.txt') -Encoding utf8
    Get-FileHash -LiteralPath (Join-Path $kit 'ffmpeg.exe'), (Join-Path $kit 'ffprobe.exe')
} finally {
    Pop-Location
    $env:Path = $originalPath
}
