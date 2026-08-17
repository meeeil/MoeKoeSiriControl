# Check project service status: ports, controller pairing, /health, logs
$ErrorActionPreference = 'SilentlyContinue'

function Test-PortListening([int]$port) {
    try {
        $client = New-Object Net.Sockets.TcpClient
        $client.Connect('127.0.0.1', $port)
        $client.Close()
        return $true
    } catch {
        return $false
    }
}

$root = Split-Path -Parent $PSScriptRoot
$envFile = "$root\.env"
$apiPort = 6521
$webPort = 8080
$controlPort = 8200
if (Test-Path $envFile) {
    $apiPort = [int](((Get-Content $envFile | Where-Object { $_ -match '^MOEKOE_API_PORT=' } | Select-Object -First 1) -replace '^MOEKOE_API_PORT=', '').Trim())
    $webPort = [int](((Get-Content $envFile | Where-Object { $_ -match '^WEB_PORT=' } | Select-Object -First 1) -replace '^WEB_PORT=', '').Trim())
    $controlPort = [int](((Get-Content $envFile | Where-Object { $_ -match '^CONTROL_PORT=' } | Select-Object -First 1) -replace '^CONTROL_PORT=', '').Trim())
}

Write-Host 'Port status:'
Write-Host ("  {0,-6} {1,-6} {2}" -f 'Port', 'Listen', 'Role')
Write-Host ("  {0,-6} {1,-6} {2}" -f $apiPort, (Test-PortListening $apiPort), 'MoeKoeMusic API (loopback)')
Write-Host ("  {0,-6} {1,-6} {2}" -f $webPort, (Test-PortListening $webPort), 'Web host (WebUI)')
Write-Host ("  {0,-6} {1,-6} {2}" -f $controlPort, (Test-PortListening $controlPort), 'Control service (WS/HTTP)')

Write-Host ''
Write-Host 'Controller pairing (run\controller.json):'
$controllerJson = Join-Path $root 'run\controller.json'
if (Test-Path $controllerJson) {
    try {
        $controller = Get-Content $controllerJson -Raw | ConvertFrom-Json
        if ($controller.deviceId) {
            Write-Host ("  paired      {0}" -f $controller.deviceId)
            Write-Host ("  pairedAt    {0}" -f ([DateTimeOffset]::FromUnixTimeMilliseconds([int64]$controller.pairedAt).LocalDateTime.ToString('yyyy-MM-dd HH:mm:ss')))
        } else {
            Write-Host '  paired      NO'
        }
        if ($controller.corrupt) { Write-Host '  corrupt     YES (controller.json was invalid)' }
    } catch {
        Write-Host '  unreadable  controller.json is invalid JSON'
    }
} else {
    Write-Host '  missing     run\controller.json does not exist (never paired)'
}

Write-Host ''
Write-Host 'Control service /health:'
if (Test-PortListening $controlPort) {
    try {
        $health = Invoke-RestMethod -Uri "http://127.0.0.1:$controlPort/health" -TimeoutSec 3
        Write-Host ("  controller  paired={0} online={1}" -f $health.controller.paired, $health.controller.online)
        Write-Host ("  upstream    {0} (http {1})" -f $(if ($null -eq $health.upstream.reachable) { 'unknown' } else { $health.upstream.reachable }), $health.upstream.status)
        if ($health.sessionAuth) {
            Write-Host ("  sessionAuth configured={0} state={1} attemptsRemaining={2}" -f $health.sessionAuth.configured, $health.sessionAuth.state, $health.sessionAuth.attemptsRemaining)
        }
    } catch {
        Write-Host '  /health unreachable'
    }
} else {
    Write-Host '  (control service not listening)'
}

Write-Host ''
Write-Host 'Logs (run\*.log):'
$logs = Get-ChildItem "$root\run\*.log" -ErrorAction SilentlyContinue
if ($logs) {
    $logs | Sort-Object Name | ForEach-Object {
        $sizeKB = [math]::Round($_.Length / 1KB, 1)
        Write-Host ("  {0,-20} {1,8} KB  {2}" -f $_.Name, $sizeKB, $_.LastWriteTime.ToString('yyyy-MM-dd HH:mm:ss'))
    }
} else {
    Write-Host '  (no log files)'
}

Write-Host ''
Write-Host 'Related node processes:'
$procs = Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object {
    $_.CommandLine -match 'server[/\\]index\.js|api[/\\]app\.js'
}
if ($procs) {
    $procs | ForEach-Object { Write-Host ("  PID {0,-7} {1}" -f $_.ProcessId, $_.CommandLine) }
} else {
    Write-Host '  (none)'
}
