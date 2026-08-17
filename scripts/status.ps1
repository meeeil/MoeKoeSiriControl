# Check project service status: 6521 API, 8080 Web host, 8200 control service
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
Write-Host ("  {0,-6} {1,-6} {2}" -f $apiPort, (Test-PortListening $apiPort), 'MoeKoeMusic API')
Write-Host ("  {0,-6} {1,-6} {2}" -f $webPort, (Test-PortListening $webPort), 'Web host (WebUI)')
Write-Host ("  {0,-6} {1,-6} {2}" -f $controlPort, (Test-PortListening $controlPort), 'Control service (WS/HTTP)')

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