# Stop the node processes for this project (6521 API and 8080/8200 control server)
$ErrorActionPreference = 'Stop'

$targets = Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object {
    $_.CommandLine -match 'server[/\\]index\.js|api[/\\]app\.js'
}

if (-not $targets) {
    Write-Host '[stop-all] No matching node process to stop.'
    exit 0
}

$targets | ForEach-Object {
    Write-Host "[stop-all] Stopping PID $($_.ProcessId): $($_.CommandLine)"
    Stop-Process -Id $_.ProcessId -Force
}

Start-Sleep -Milliseconds 800
Write-Host '[stop-all] Done.'