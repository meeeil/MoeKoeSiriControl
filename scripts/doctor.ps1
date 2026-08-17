# MoeKoeSiriControl doctor: read-only diagnostic checklist.
# Run any time:  powershell -ExecutionPolicy Bypass -File scripts/doctor.ps1
# Exits non-zero when any hard check FAILS. No changes are made.
$ErrorActionPreference = 'SilentlyContinue'

$root = Split-Path -Parent $PSScriptRoot
$envFile = "$root\.env"
$failures = 0
$warnings = 0

function Report([string]$kind, [string]$name, [string]$detail) {
    Write-Host ("[{0}] {1}{2}" -f $kind, $name, $(if ($detail) { " - $detail" } else { '' }))
    if ($kind -eq 'FAIL') { $script:failures++ }
    if ($kind -eq 'WARN') { $script:warnings++ }
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

function Get-EnvValue([string]$name, [string]$def) {
    if (-not (Test-Path $envFile)) { return $def }
    $line = Get-Content $envFile | Where-Object { $_ -match "^$name=" } | Select-Object -First 1
    if ($line) { return ($line -replace "^$name=", '').Trim() }
    return $def
}

Write-Host "MoeKoeSiriControl doctor ($root)"
Write-Host ('Date: {0}' -f (Get-Date).ToString('yyyy-MM-dd HH:mm:ss'))
Write-Host ''

# 1. node
$node = Get-Command node -ErrorAction SilentlyContinue
if ($node) {
    $nodeVer = (& node --version).Trim()
    Report 'OK' "node $nodeVer"
    if ($nodeVer -replace 'v', '' -match '^(\d+)' -and [int]$Matches[1] -lt 20) {
        Report 'WARN' 'node version' '>= 20 required, older may not support node:test / AbortSignal.timeout'
    }
} else {
    Report 'FAIL' 'node' 'not on PATH'
}

# 2. .env
if (-not (Test-Path $envFile)) {
    Report 'FAIL' '.env' 'missing - copy .env.example and fill tokens'
} else {
    Report 'OK' '.env'
    foreach ($name in @('SIRI_HTTP_TOKEN', 'SIRI_WS_TOKEN')) {
        $val = Get-EnvValue $name ''
        if ($val.Length -lt 32) {
            Report 'FAIL' ".env $name" 'missing or shorter than 32 bytes'
        } else {
            Report 'OK' ".env $name" "len=$($val.Length)"
        }
    }
    $moekoeDir = Get-EnvValue 'MOEKOE_DIR' ''
    $dist = Get-EnvValue 'MOEKOE_DIST_DIR' (Join-Path $moekoeDir 'dist')
    if (-not (Test-Path $dist)) {
        Report 'WARN' 'MOEKOE_DIST_DIR' "not found: $dist"
    } else {
        Report 'OK' 'dist dir' $dist
    }
}

# 3. ports
$apiPort = [int](Get-EnvValue 'MOEKOE_API_PORT' '6521')
$webPort = [int](Get-EnvValue 'WEB_PORT' '8080')
$controlPort = [int](Get-EnvValue 'CONTROL_PORT' '8200')
foreach ($p in @(@($apiPort, 'API (6521)'), @($webPort, 'Web host (8080)'), @($controlPort, 'Control (8200)'))) {
    $port = [int]$p[0]
    $role = $p[1]
    if (Test-PortListening $port) {
        Report 'OK' "port $port" "$role listening"
    } else {
        Report 'WARN' "port $port" "$role NOT listening (expected if services are stopped)"
    }
}

# 4. controller pairing
$controllerJson = Join-Path $root 'run\controller.json'
if (Test-Path $controllerJson) {
    try {
        $controller = Get-Content $controllerJson -Raw | ConvertFrom-Json
        if ($controller.deviceId) {
            Report 'OK' 'controller paired' $controller.deviceId
        } else {
            Report 'WARN' 'controller paired' 'no deviceId - iPad not paired yet'
        }
        if ($controller.corrupt) { Report 'FAIL' 'controller.json corrupt' 'file was invalid JSON on read' }
    } catch {
        Report 'FAIL' 'controller.json' 'invalid JSON'
    }
} else {
    Report 'WARN' 'controller paired' 'run\controller.json missing - never paired'
}

# 5. /health
if (Test-PortListening $controlPort) {
    try {
        $health = Invoke-RestMethod -Uri "http://127.0.0.1:$controlPort/health" -TimeoutSec 3
        Report 'OK' '/health' "protocol=$($health.protocol) controller.online=$($health.controller.online)"
        if ($null -eq $health.upstream.reachable) {
            Report 'WARN' 'upstream reachable' 'unknown (API not answering yet?)'
        } elseif (-not $health.upstream.reachable) {
            Report 'WARN' 'upstream reachable' "false (http $($health.upstream.status)) - check MoeKoeMusic API"
        } else {
            Report 'OK' 'upstream reachable' "http $($health.upstream.status)"
        }
        if ($health.sessionAuth) {
            Report 'OK' 'session-auth breaker' "configured=$($health.sessionAuth.configured) state=$($health.sessionAuth.state)"
        }
    } catch {
        Report 'FAIL' '/health' 'unreachable'
    }
}

# 6. firewall rules (check only)
$firewall = powershell -NoProfile -ExecutionPolicy Bypass -File "$root\scripts\firewall.ps1"
$fwText = ($firewall | Out-String)
if ($fwText -match 'NO MoeKoeSiriControl rule present') {
    Report 'WARN' 'firewall rules' '8080/8200 inbound allow rules missing - run scripts/firewall.ps1 -Apply as admin (iPad will not reach WebUI)'
} else {
    Report 'OK' 'firewall rules' 'MoeKoeSiriControl rules present (or elevated check unavailable)'
}

# 7. rollback / backups
$prev = Join-Path $root 'backups\dist.prev'
if (Test-Path $prev) {
    $items = @(Get-ChildItem $prev -Force).Count
    Report 'OK' 'backups/dist.prev' "$items entries"
} else {
    Report 'WARN' 'backups/dist.prev' 'missing - build has never snapshotted dist'
}

# 8. log rotation
$archive = Join-Path $root 'run\logs-archive'
if (Test-Path $archive) {
    $count = @(Get-ChildItem $archive -Directory).Count
    Report 'OK' 'log archives' "$count kept"
} else {
    Report 'OK' 'log archives' 'none yet (rotates on next start)'
}

# 9. git state
foreach ($repo in @($root, (Get-EnvValue 'MOEKOE_DIR' ''))) {
    if (-not $repo -or -not (Test-Path $repo)) { continue }
    $gitDir = Join-Path $repo '.git'
    if (-not (Test-Path $gitDir)) { continue }
    $git = git -C $repo status --short
    if ($git) {
        Report 'WARN' "git dirty ($repo)" (($git | Select-Object -First 3) -join ' | ')
    } else {
        Report 'OK' "git clean ($repo)"
    }
}

Write-Host ''
if ($failures -gt 0) {
    Write-Host "[doctor] $failures FAIL, $warnings WARN"
    exit 1
}
if ($warnings -gt 0) {
    Write-Host "[doctor] all hard checks OK ($warnings warnings)"
} else {
    Write-Host '[doctor] all checks OK'
}
exit 0
