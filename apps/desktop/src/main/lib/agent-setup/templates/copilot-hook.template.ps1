# {{MARKER}}
# Called by GitHub Copilot CLI hooks to notify Superset of agent lifecycle events.
# The Copilot CLI expects valid JSON on stdout; emit it ASAP so the agent is not
# blocked while we fire the notification request.
[CmdletBinding()]
param([string]$EventName)

$ErrorActionPreference = 'Continue'

# Drain stdin so the agent isn't blocked by a broken pipe.
if ([Console]::IsInputRedirected) {
	[Console]::In.ReadToEnd() | Out-Null
}

switch ($EventName) {
	'sessionStart'        { $EventType = 'Start' }
	'sessionEnd'          { $EventType = 'Stop' }
	'userPromptSubmitted' { $EventType = 'Start' }
	'postToolUse'         { $EventType = 'Start' }
	'preToolUse'          { $EventType = 'PermissionRequest' }
	default {
		Write-Output '{}'
		exit 0
	}
}

# Must output valid JSON to avoid blocking the agent.
Write-Output '{}'

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
	# Silent — the agent must not be blocked by transient notification failures.
}

exit 0
