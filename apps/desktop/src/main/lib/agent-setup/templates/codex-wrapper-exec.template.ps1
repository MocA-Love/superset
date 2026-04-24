# PowerShell counterpart to codex-wrapper-exec.template.sh.
#
# Native ~/.codex/hooks.json already owns SessionStart / UserPromptSubmit / Stop.
# The wrapper keeps a tail-based session-log watcher only for per-prompt Start
# notifications and permission requests inside Superset terminals.
$ErrorActionPreference = 'Continue'

$WatcherJob = $null

if ($env:SUPERSET_TAB_ID -and (Test-Path -LiteralPath '{{NOTIFY_PATH}}')) {
	$env:CODEX_TUI_RECORD_SESSION = '1'
	if (-not $env:CODEX_TUI_SESSION_LOG_PATH) {
		$ts = [int][double]::Parse((Get-Date -UFormat %s))
		$tmp = if ($env:TEMP) { $env:TEMP } else { [System.IO.Path]::GetTempPath() }
		$env:CODEX_TUI_SESSION_LOG_PATH = Join-Path $tmp ("superset-codex-session-{0}_{1}.jsonl" -f $PID, $ts)
	}

	$notifyPath = '{{NOTIFY_PATH}}'
	$logPath = $env:CODEX_TUI_SESSION_LOG_PATH

	$WatcherJob = Start-Job -ScriptBlock {
		param($log, $notify)

		function Send-HookEvent([string]$notifyScript, [string]$eventName) {
			$payload = ('{{"hook_event_name":"{0}"}}' -f $eventName)
			try {
				powershell.exe -NoProfile -ExecutionPolicy Bypass -File $notifyScript $payload | Out-Null
			} catch {
				# Silent — lifecycle notifications must not block codex.
			}
		}

		$lastTurnId = ''
		$lastApprovalId = ''
		$lastExecCallId = ''
		$approvalFallback = 0

		# Wait (up to ~10s) for codex to create the session log.
		for ($i = 0; $i -lt 200 -and -not (Test-Path -LiteralPath $log); $i++) {
			Start-Sleep -Milliseconds 50
		}
		if (-not (Test-Path -LiteralPath $log)) { return }

		Get-Content -LiteralPath $log -Wait -Tail 0 | ForEach-Object {
			$line = $_

			if ($line -match '"dir":"to_tui"' -and $line -match '"kind":"codex_event"' -and $line -match '"msg":\{"type":"task_started"') {
				$m = [regex]::Match($line, '"turn_id":"([^"]*)"')
				$turnId = if ($m.Success) { $m.Groups[1].Value } else { 'task_started' }
				if ($turnId -ne $lastTurnId) {
					$lastTurnId = $turnId
					Send-HookEvent -notifyScript $notify -eventName 'Start'
				}
				return
			}

			if ($line -match '"dir":"to_tui"' -and $line -match '"kind":"codex_event"' -and $line -match '"msg":\{"type":"[^"]*_approval_request"') {
				$approvalId = ''
				foreach ($field in @('id', 'approval_id', 'call_id')) {
					$pattern = '"' + $field + '":"([^"]*)"'
					$m = [regex]::Match($line, $pattern)
					if ($m.Success) { $approvalId = $m.Groups[1].Value; break }
				}
				if (-not $approvalId) {
					$approvalFallback++
					$approvalId = "approval_request_$approvalFallback"
				}
				if ($approvalId -ne $lastApprovalId) {
					$lastApprovalId = $approvalId
					Send-HookEvent -notifyScript $notify -eventName 'PermissionRequest'
				}
				return
			}

			if ($line -match '"dir":"to_tui"' -and $line -match '"kind":"codex_event"' -and $line -match '"msg":\{"type":"exec_command_begin"') {
				$m = [regex]::Match($line, '"call_id":"([^"]*)"')
				$execCallId = if ($m.Success) { $m.Groups[1].Value } else { '' }
				if ($execCallId) {
					if ($execCallId -ne $lastExecCallId) {
						$lastExecCallId = $execCallId
						Send-HookEvent -notifyScript $notify -eventName 'Start'
					}
				} else {
					Send-HookEvent -notifyScript $notify -eventName 'Start'
				}
			}
		}
	} -ArgumentList $logPath, $notifyPath
}

try {
	& '{{REAL_BIN}}' --enable codex_hooks @args
	$codexStatus = $LASTEXITCODE
} finally {
	if ($WatcherJob) {
		Stop-Job -Job $WatcherJob -PassThru | Receive-Job -ErrorAction SilentlyContinue | Out-Null
		Remove-Job -Job $WatcherJob -Force -ErrorAction SilentlyContinue | Out-Null
	}
}

exit $codexStatus
