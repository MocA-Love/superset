# {{MARKER}}
# Called by cursor-agent hooks to notify Superset of agent lifecycle events.
# Permission hooks must respond with {"continue":true} so execution is not blocked.
[CmdletBinding()]
param([string]$EventName)

$ErrorActionPreference = 'Continue'

# Drain stdin so the agent isn't blocked by a broken pipe.
if ([Console]::IsInputRedirected) {
	[Console]::In.ReadToEnd() | Out-Null
}

switch ($EventName) {
	'Start' { $EventType = 'Start'; $NeedsResponse = $false }
	'Stop'  { $EventType = 'Stop'; $NeedsResponse = $false }
	'PermissionRequest' { $EventType = 'PermissionRequest'; $NeedsResponse = $true }
	default { exit 0 }
}

if ($NeedsResponse) {
	Write-Output '{"continue":true}'
}

if (-not $env:SUPERSET_TAB_ID) { exit 0 }

{{SLEEP_INHIBITOR_SNIPPET}}

$Port = if ($env:SUPERSET_PORT) { $env:SUPERSET_PORT } else { '{{DEFAULT_PORT}}' }
$Fields = [ordered]@{
	paneId      = $env:SUPERSET_PANE_ID
	tabId       = $env:SUPERSET_TAB_ID
	workspaceId = $env:SUPERSET_WORKSPACE_ID
	eventType   = $EventType
	env         = $env:SUPERSET_ENV
	version     = $env:SUPERSET_HOOK_VERSION
}
$Query = ($Fields.GetEnumerator() | ForEach-Object {
	$value = if ($null -eq $_.Value) { '' } else { [string]$_.Value }
	"{0}={1}" -f [Uri]::EscapeDataString($_.Key), [Uri]::EscapeDataString($value)
}) -join '&'

try {
	Invoke-WebRequest -Uri "http://127.0.0.1:$Port/hook/complete?$Query" `
		-Method Get -UseBasicParsing -TimeoutSec 2 -ErrorAction Stop | Out-Null
} catch {
	# Silent.
}

exit 0
