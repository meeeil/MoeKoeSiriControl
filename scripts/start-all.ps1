# One-click start: 6521 MoeKoeMusic API + 8080 Web host + 8200 control service (WS/HTTP)
# Usage: powershell -ExecutionPolicy Bypass -File scripts/start-all.ps1
$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot   # scripts/ -> project root
Set-Location $root

if (-not (Test-Path "$root\.env")) {
    throw '.env not found. Copy .env.example to .env and fill in the tokens first.'
}

function Get-EnvValue([string]$name, [string]$def) {
    $line = Get-Content "$root\.env" | Where-Object { $_ -match "^$name=" } | Select-Object -First 1
    if ($line) { return ($line -replace "^$name=", '').Trim() }
    return $def
}

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

function Ensure-NodeAvailable {
    if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
        throw 'node not found. Install Node.js >= 20 first.'
    }
}

# Launch a truly detached process via WMI (not a child of this console), so the
# calling terminal returns immediately instead of waiting on the server's handles.
# Writes a small .cmd batch file (which owns cd + redirection) and WMI-launches
# it with a HIDDEN window (no black console boxes).
function Start-DetachedProcess([string]$name, [string]$workDir, [string]$command, [string]$outLog, [string]$errLog, [string[]]$envLines = @()) {
    $batchPath = Join-Path $root "run\start-$name.cmd"
    $content = '@echo off' + [Environment]::NewLine +
        "cd /d `"$workDir`"" + [Environment]::NewLine
    foreach ($line in $envLines) {
        $content += $line + [Environment]::NewLine
    }
    $content += "$command 1> `"$outLog`" 2> `"$errLog`"" + [Environment]::NewLine
    Set-Content -LiteralPath $batchPath -Value $content -Encoding Ascii
    $startupInfo = ([wmiclass]'Win32_ProcessStartup').CreateInstance()
    $startupInfo.ShowWindow = 0
    $result = Invoke-WmiMethod -Class Win32_Process -Name Create `
        -ArgumentList "`"$batchPath`"", $workDir, $startupInfo
    if ($result.ReturnValue -ne 0) {
        throw "failed to start $name (Win32_Process.Create=$($result.ReturnValue)): $batchPath"
    }
    return $result.ProcessId
}

$apiPort   = [int](Get-EnvValue 'MOEKOE_API_PORT' '6521')
$webPort   = [int](Get-EnvValue 'WEB_PORT' '8080')
$controlPort = [int](Get-EnvValue 'CONTROL_PORT' '8200')
$defaultMoekoeDir = [System.IO.Path]::GetFullPath((Join-Path $root '..\MoeKoeMusic'))
$moekoeDir = (Get-EnvValue 'MOEKOE_DIR' $defaultMoekoeDir)
$moekoeDist = (Get-EnvValue 'MOEKOE_DIST_DIR' (Join-Path $moekoeDir 'dist'))

if (-not (Test-Path $moekoeDist)) {
    throw "dist not found ($moekoeDist). Run 'npm run build:web' in MoeKoeSiriControl first."
}
if (-not (Test-Path "$root\server\index.js")) {
    throw "server/index.js not found ($root). Check the project path."
}

Ensure-NodeAvailable

New-Item -ItemType Directory -Force -Path "$root\run" | Out-Null

$nodeExe = (Get-Command node).Source

function Rotate-Logs {
    # Archive run/*.log + run/*.err.log before starting fresh, keep the 10 most
    # recent archives, and delete archived files older than 14 days.
    $runDir = Join-Path $root 'run'
    $archiveRoot = Join-Path $runDir 'logs-archive'
    $logs = @(Get-ChildItem $runDir -File -ErrorAction SilentlyContinue | Where-Object { $_.Name -match '\.(log|err\.log)$' })
    if ($logs.Count -gt 0) {
        $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
        $dest = Join-Path $archiveRoot $stamp
        New-Item -ItemType Directory -Force -Path $dest | Out-Null
        foreach ($log in $logs) {
            try {
                Move-Item -LiteralPath $log.FullName -Destination $dest -Force
            } catch {
                Write-Warning "[start-all] could not archive $($log.Name) (file in use?) - leaving it"
            }
        }
        Write-Host "[start-all] archived $($logs.Count) log file(s) -> run\logs-archive\$stamp"
    }
    $archives = @(Get-ChildItem $archiveRoot -Directory -ErrorAction SilentlyContinue | Sort-Object Name)
    if ($archives.Count -gt 10) {
        $archives | Select-Object -First ($archives.Count - 10) | ForEach-Object {
            Remove-Item -LiteralPath $_.FullName -Recurse -Force
            Write-Host "[start-all] pruned old log archive $($_.Name)"
        }
    }
    $cutoff = (Get-Date).AddDays(-14)
    Get-ChildItem $archiveRoot -Recurse -File -ErrorAction SilentlyContinue | Where-Object { $_.LastWriteTime -lt $cutoff } | ForEach-Object {
        Remove-Item -LiteralPath $_.FullName -Force
    }
}

# Archive old logs first (keep 10 archives, 14-day retention).
Rotate-Logs

# 1) API (6521) - skip if already listening
if (Test-PortListening $apiPort) {
    Write-Host "[start-all] API already listening on :$apiPort - skip"
} else {
    Write-Host "[start-all] Starting API on 127.0.0.1:$apiPort ..."
    Start-DetachedProcess 'api' $moekoeDir "`"$nodeExe`" api/app.js --platform=lite --port=$apiPort" `
        "$root\run\api.log" "$root\run\api.err.log" @('set HOST=127.0.0.1')
}

# 2) Web host + control service (8080 + 8200) - skip if already listening
if (Test-PortListening $webPort) {
    Write-Host "[start-all] Control server already listening on :$webPort - skip (run 'npm run stop:all' first to reload code)"
} else {
    Write-Host "[start-all] Starting Web host(:$webPort) + control service(:$controlPort) ..."
    Start-DetachedProcess 'server' $root "`"$nodeExe`" server/index.js" `
        "$root\run\web-host.log" "$root\run\web-host.err.log"
}

# 3) Wait for readiness (poll up to ~10s; API can take a few seconds to bind)
Start-Sleep -Milliseconds 1500
$deadline = [DateTime]::UtcNow.AddSeconds(10)
$ready = $false
while (-not $ready -and [DateTime]::UtcNow -lt $deadline) {
    $ready = $true
    foreach ($port in @($apiPort, $webPort)) {
        if (-not (Test-PortListening $port)) { $ready = $false }
    }
    if (-not $ready) { Start-Sleep -Milliseconds 500 }
}
if (-not $ready) {
    Write-Warning 'Some ports are not ready yet. Check with scripts/status.ps1 shortly.'
} else {
    Write-Host '[start-all] All ready:'
    Write-Host "  WebUI    http://localhost:$webPort"
    Write-Host "  API      127.0.0.1:$apiPort"
    Write-Host "  WS/HTTP  ws://localhost:$controlPort/ws  http://localhost:$controlPort/api/siri/play"
    Write-Host '  Logs: run\web-host.log / run\api.log'
}
