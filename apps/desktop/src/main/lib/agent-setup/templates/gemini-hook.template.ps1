# {{MARKER}}
# Called by Gemini CLI hooks to notify Superset of agent lifecycle events.
# Gemini passes JSON via stdin and expects valid JSON on stdout.
[CmdletBinding()]
param()

$ErrorActionPreference = 'Continue'

function Get-JsonStringValue([string]$Text, [string]$Key) {
	if (-not $Text) { return '' }
	$pattern = '"' + [regex]::Escape($Key) + '"\s*:\s*"([^"]*)"'
	$match = [regex]::Match($Text, $pattern)
	if ($match.Success) { return $match.Groups[1].Value }
	return ''
}

$Input = [Console]::In.ReadToEnd()
$GeminiEvent = Get-JsonStringValue $Input 'hook_event_name'

switch ($GeminiEvent) {
	'BeforeAgent' { $EventType = 'Start' }
	'AfterAgent'  { $EventType = 'Stop' }
	'AfterTool'   { $EventType = 'Start' }
	default {
		Write-Output '{}'
		exit 0
	}
}

# Output the required JSON response immediately to avoid blocking the agent.
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
	# Silent.
}

exit 0
