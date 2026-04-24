# {{MARKER}}
# Called by CLI agents (Claude Code, Codex, etc.) when they complete or need input.
# This is the PowerShell sibling of notify-hook.template.sh — keep the two in lockstep.
[CmdletBinding()]
param([string]$JsonArg)

$ErrorActionPreference = 'Continue'

function Get-JsonStringValue([string]$Text, [string]$Key) {
	if (-not $Text) { return '' }
	$pattern = '"' + [regex]::Escape($Key) + '"\s*:\s*"([^"]*)"'
	$match = [regex]::Match($Text, $pattern)
	if ($match.Success) { return $match.Groups[1].Value }
	return ''
}

# Codex passes JSON as argument, Claude pipes it to stdin.
$Json = if ($JsonArg) { $JsonArg } else { [Console]::In.ReadToEnd() }

$HookSessionId = Get-JsonStringValue $Json 'session_id'
$ResourceId = Get-JsonStringValue $Json 'resourceId'
if (-not $ResourceId) { $ResourceId = Get-JsonStringValue $Json 'resource_id' }
$SessionId = if ($ResourceId) { $ResourceId } else { $HookSessionId }

if (-not $env:SUPERSET_TAB_ID -and -not $SessionId) { exit 0 }

$EventType = Get-JsonStringValue $Json 'hook_event_name'
if (-not $EventType) {
	$CodexType = Get-JsonStringValue $Json 'type'
	switch ($CodexType) {
		'agent-turn-complete' { $EventType = 'Stop' }
		'task_complete' { $EventType = 'Stop' }
		'task_started' { $EventType = 'Start' }
		'exec_approval_request' { $EventType = 'PermissionRequest' }
		'apply_patch_approval_request' { $EventType = 'PermissionRequest' }
		'request_user_input' { $EventType = 'PermissionRequest' }
	}
}

if ($EventType -eq 'UserPromptSubmit') { $EventType = 'Start' }
if (-not $EventType) { exit 0 }

{{SLEEP_INHIBITOR_SNIPPET}}

$DebugEnabled = $false
if ($env:SUPERSET_DEBUG_HOOKS) {
	if ($env:SUPERSET_DEBUG_HOOKS -match '^(1|true|TRUE|True|yes|YES|on|ON)$') {
		$DebugEnabled = $true
	}
} elseif ($env:SUPERSET_ENV -eq 'development' -or $env:NODE_ENV -eq 'development') {
	$DebugEnabled = $true
}

if ($DebugEnabled) {
	[Console]::Error.WriteLine("[notify-hook] event=$EventType sessionId=$SessionId hookSessionId=$HookSessionId resourceId=$ResourceId paneId=$env:SUPERSET_PANE_ID tabId=$env:SUPERSET_TAB_ID workspaceId=$env:SUPERSET_WORKSPACE_ID wrapperPid=$env:SUPERSET_WRAPPER_PID")
}

$Port = if ($env:SUPERSET_PORT) { $env:SUPERSET_PORT } else { '{{DEFAULT_PORT}}' }
$Fields = [ordered]@{
	paneId        = $env:SUPERSET_PANE_ID
	tabId         = $env:SUPERSET_TAB_ID
	workspaceId   = $env:SUPERSET_WORKSPACE_ID
	sessionId     = $SessionId
	hookSessionId = $HookSessionId
	resourceId    = $ResourceId
	eventType     = $EventType
	env           = $env:SUPERSET_ENV
	version       = $env:SUPERSET_HOOK_VERSION
}
$Query = ($Fields.GetEnumerator() | ForEach-Object {
	$value = if ($null -eq $_.Value) { '' } else { [string]$_.Value }
	"{0}={1}" -f [Uri]::EscapeDataString($_.Key), [Uri]::EscapeDataString($value)
}) -join '&'

try {
	$response = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/hook/complete?$Query" `
		-Method Get -UseBasicParsing -TimeoutSec 2 -ErrorAction Stop
	if ($DebugEnabled) {
		[Console]::Error.WriteLine("[notify-hook] dispatched status=$($response.StatusCode)")
	}
} catch {
	if ($DebugEnabled) {
		[Console]::Error.WriteLine("[notify-hook] dispatch failed: $_")
	}
}

exit 0
