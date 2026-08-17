# MoeKoeSiriControl firewall helper.
#
# The Web host (8080) and control service (8200) listen on 0.0.0.0 so the iPad
# / phones on the LAN can reach them. Windows Firewall blocks inbound by
# default, so this script can create the two needed inbound allow rules.
# The KuGou API (6521) is loopback-only and must NOT get a firewall rule.
#
#   powershell -ExecutionPolicy Bypass -File scripts/firewall.ps1            # check only (no changes)
#   powershell -ExecutionPolicy Bypass -File scripts/firewall.ps1 -Apply     # create missing rules (admin)
#   powershell -ExecutionPolicy Bypass -File scripts/firewall.ps1 -Rollback  # remove ONLY rules this script created (admin)
#
# -Apply is idempotent and never touches rules it did not create.
# -Rollback removes only rules named MoeKoeSiriControl-*. It never deletes
# pre-existing firewall rules.
param(
    [switch]$Apply,
    [switch]$Rollback
)

$ErrorActionPreference = 'Stop'

$ports = @(8080, 8200)

function Test-Admin {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($identity)
    return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Get-MoeKoeRules([int]$port) {
    try {
        return @(Get-NetFirewallRule -Name "MoeKoeSiriControl-$port" -ErrorAction SilentlyContinue)
    } catch {
        return @()
    }
}

if ($Apply -and $Rollback) {
    throw 'Use either -Apply or -Rollback, not both.'
}

if (-not (Test-Admin)) {
    if ($Apply -or $Rollback) {
        throw 'Firewall changes require an elevated (Administrator) PowerShell. Re-run as admin.'
    }
    Write-Host '[firewall] Not elevated - reporting rules only (no changes).'
}

foreach ($port in $ports) {
    $rules = Get-MoeKoeRules $port
    if ($rules.Count -eq 0) {
        Write-Host "[firewall] :$port - NO MoeKoeSiriControl rule present"
    } else {
        $enabled = @($rules | Where-Object { $_.Enabled -eq $true }).Count
        Write-Host "[firewall] :$port - MoeKoeSiriControl rule present (rules=$($rules.Count) enabled=$enabled)"
    }
}

if ($Rollback) {
    foreach ($port in $ports) {
        $rules = Get-MoeKoeRules $port
        if ($rules.Count -gt 0) {
            $rules | Remove-NetFirewallRule
            Write-Host "[firewall] :$port - removed MoeKoeSiriControl-$port"
        } else {
            Write-Host "[firewall] :$port - nothing to remove"
        }
    }
    Write-Host '[firewall] Rollback done. Pre-existing firewall rules were left untouched.'
    return
}

if ($Apply) {
    foreach ($port in $ports) {
        $rules = Get-MoeKoeRules $port
        if ($rules.Count -gt 0) {
            Write-Host "[firewall] :$port - rule already exists, keeping it"
            continue
        }
        New-NetFirewallRule `
            -Name "MoeKoeSiriControl-$port" `
            -DisplayName "MoeKoeSiriControl-$port" `
            -Description "MoeKoeSiriControl inbound allow for port $port (created by scripts/firewall.ps1)" `
            -Direction Inbound `
            -Action Allow `
            -Protocol TCP `
            -LocalPort $port `
            -Profile Private `
            -RemoteAddress LocalSubnet | Out-Null
        Write-Host "[firewall] :$port - rule created (TCP, Private profile, LocalSubnet only)"
    }
    Write-Host '[firewall] Apply done. Note: the KuGou API (6521) is loopback-only and gets no rule.'
}