param([switch]$NoBrowser)
$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path $PSScriptRoot -Parent
Set-Location $taskRoot
$env:DOTNET_CLI_TELEMETRY_OPTOUT = '1'
$taskDotnet = Join-Path $taskRoot '.tools/dotnet/dotnet.exe'
if (-not (Test-Path $taskDotnet)) { $taskDotnet = (Get-Command dotnet -ErrorAction Stop).Source }
if (-not (Get-Command npm.cmd -ErrorAction SilentlyContinue)) { throw 'Please install Node.js 24 LTS first.' }
$taskBusy = $false
try {
    Invoke-RestMethod 'http://127.0.0.1:5188/api/v1/health' -TimeoutSec 1 | Out-Null
    $taskBusy = $true
} catch { }
if ($taskBusy) { throw 'Port 5188 is already in use. Stop the existing server before starting MshTV.' }
Push-Location (Join-Path $taskRoot 'apps/web')
try {
    if (-not (Test-Path node_modules)) { & npm.cmd ci; if ($LASTEXITCODE) { throw 'npm ci failed' } }
    & npm.cmd run build
    if ($LASTEXITCODE) { throw 'Frontend build failed' }
} finally { Pop-Location }
$taskWebRoot = Join-Path $taskRoot 'src/MshTV.Server/wwwroot'
New-Item -ItemType Directory -Force $taskWebRoot | Out-Null
Copy-Item -Path (Join-Path $taskRoot 'apps/web/dist/*') -Destination $taskWebRoot -Recurse -Force
& $taskDotnet build src/MshTV.Server/MshTV.Server.csproj --runtime win-x64 --self-contained -p:RestoreLockedMode=true
if ($LASTEXITCODE) { throw 'Backend build failed. .NET 10 SDK is required.' }
Write-Host 'MshTV: http://127.0.0.1:5188  |  Close this window or press Ctrl+C to stop.'
# Browser opens once health is ready; this helper creates no visible window.
if (-not $NoBrowser) {
    $taskOpen = Join-Path $PSScriptRoot 'open-browser.ps1'
    Start-Process powershell.exe -WindowStyle Hidden -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ('"' + $taskOpen + '"'), '-LauncherPid', $PID) | Out-Null
}
& $taskDotnet run --no-build --project src/MshTV.Server/MshTV.Server.csproj --runtime win-x64 --self-contained
exit $LASTEXITCODE
