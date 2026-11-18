param([Parameter(Mandatory = $true)][int]$LauncherPid)
while (Get-Process -Id $LauncherPid -ErrorAction SilentlyContinue) {
    try {
        $taskHealth = Invoke-RestMethod 'http://127.0.0.1:5188/api/v1/health' -TimeoutSec 1
        if ($taskHealth.name -eq 'MshTV') { Start-Process 'http://127.0.0.1:5188'; exit }
    } catch { }
    Start-Sleep -Milliseconds 500
}
