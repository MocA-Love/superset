# Native ~/.codex/hooks.json handles SessionStart/UserPromptSubmit/Stop.
# The wrapper keeps the session-log watcher only for per-prompt Start
# notifications and permission requests inside Superset terminals.
_superset_debug_enabled="0"
case "$SUPERSET_DEBUG_HOOKS" in
  1|true|TRUE|True|yes|YES|on|ON) _superset_debug_enabled="1" ;;
esac
if [ "$_superset_debug_enabled" != "1" ] && { [ "$SUPERSET_ENV" = "development" ] || [ "$NODE_ENV" = "development" ]; }; then
  _superset_debug_enabled="1"
fi

_superset_notify_path="{{NOTIFY_PATH}}"
_superset_debug_log="${SUPERSET_HOOK_DEBUG_LOG:-/tmp/superset-codex-hooks.log}"
_superset_has_superset_context="0"
[ -n "$SUPERSET_TERMINAL_ID$SUPERSET_TAB_ID$SUPERSET_PANE_ID" ] && _superset_has_superset_context="1"
SUPERSET_CODEX_SESSION_WATCHER_PID=""
_superset_codex_args=()

_superset_debug() {
  [ "$_superset_debug_enabled" = "1" ] || return 0
  printf '%s [codex-wrapper] %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ' 2>/dev/null || date)" "$*" >> "$_superset_debug_log" 2>/dev/null || true
}

_superset_toml_escape() {
  local _superset_value="$1"
  _superset_value="${_superset_value//\\/\\\\}"
  _superset_value="${_superset_value//\"/\\\"}"
  printf '%s' "$_superset_value"
}

_superset_configure_project_trust() {
  [ -n "${SUPERSET_WORKSPACE_PATH:-}" ] || return 0

  local _superset_workspace_codex_home="$SUPERSET_WORKSPACE_PATH/.codex"
  [ -f "$_superset_workspace_codex_home/config.toml" ] || return 0

  local _superset_workspace_path_toml
  _superset_workspace_path_toml="$(_superset_toml_escape "$SUPERSET_WORKSPACE_PATH")"
  _superset_codex_args+=("-c" "projects={\"$_superset_workspace_path_toml\"={trust_level=\"trusted\"}}")
  _superset_debug "using trusted workspace Codex project config path=$SUPERSET_WORKSPACE_PATH"
}

_superset_configure_project_trust

_superset_child_pids_for() {
  if command -v pgrep >/dev/null 2>&1; then
    pgrep -P "$1" 2>/dev/null || true
    return 0
  fi
  ps -axo pid=,ppid= 2>/dev/null | awk -v ppid="$1" '$2 == ppid { print $1 }' 2>/dev/null || true
}

_superset_cleanup_session_watcher() {
  if [ -n "$SUPERSET_CODEX_SESSION_WATCHER_PID" ]; then
    _superset_watcher_pid="$SUPERSET_CODEX_SESSION_WATCHER_PID"
    _superset_child_pids="$(_superset_child_pids_for "$_superset_watcher_pid" | tr '\n' ' ')"
    for _superset_child_pid in $_superset_child_pids; do
      kill -TERM "$_superset_child_pid" >/dev/null 2>&1 || true
    done
    kill -TERM "$_superset_watcher_pid" >/dev/null 2>&1 || true
    sleep 0.2
    _superset_child_pids="$_superset_child_pids $(_superset_child_pids_for "$_superset_watcher_pid" | tr '\n' ' ')"
    for _superset_child_pid in $_superset_child_pids; do
      kill -KILL "$_superset_child_pid" >/dev/null 2>&1 || true
    done
    kill -KILL "$_superset_watcher_pid" >/dev/null 2>&1 || true
    _superset_debug "session watcher cleanup signaled pid=$_superset_watcher_pid"
    SUPERSET_CODEX_SESSION_WATCHER_PID=""
  fi
}

_superset_exit_trap() {
  _superset_status=$?
  trap - EXIT HUP INT TERM
  _superset_cleanup_session_watcher
  exit "$_superset_status"
}

trap _superset_exit_trap EXIT HUP INT TERM

if [ "$_superset_has_superset_context" = "1" ] && [ -f "$_superset_notify_path" ]; then
  export CODEX_TUI_RECORD_SESSION="${CODEX_TUI_RECORD_SESSION:-1}"
  if [ -z "$CODEX_TUI_SESSION_LOG_PATH" ]; then
    _superset_codex_ts="$(date +%s 2>/dev/null || echo "$$")"
    export CODEX_TUI_SESSION_LOG_PATH="${TMPDIR:-/tmp}/superset-codex-session-$$_${_superset_codex_ts}.jsonl"
  fi
  _superset_debug "session watcher starting terminalId=$SUPERSET_TERMINAL_ID tabId=$SUPERSET_TAB_ID paneId=$SUPERSET_PANE_ID log=$CODEX_TUI_SESSION_LOG_PATH notify=$_superset_notify_path"

  (
    _superset_log="$CODEX_TUI_SESSION_LOG_PATH"
    _superset_notify="$_superset_notify_path"
    _superset_last_turn_id=""
    _superset_last_approval_id=""
    _superset_last_exec_call_id=""
    _superset_approval_fallback_seq=0

    _superset_emit_event() {
      _superset_event="$1"
      _superset_payload=$(printf '{"hook_event_name":"%s"}' "$_superset_event")
      _superset_debug "emitting $_superset_event via $_superset_notify"
      bash "$_superset_notify" "$_superset_payload" >/dev/null 2>&1 || true
    }

    # Wait briefly for codex to create the session log.
    _superset_i=0
    while [ ! -f "$_superset_log" ] && [ "$_superset_i" -lt 200 ]; do
      _superset_i=$((_superset_i + 1))
      sleep 0.1
    done
    if [ ! -f "$_superset_log" ]; then
      _superset_debug "session log not found path=$_superset_log"
      exit 0
    fi
    _superset_debug "watching session=$_superset_log"

    tail -n +1 -F "$_superset_log" 2>/dev/null | while IFS= read -r _superset_line; do
      case "$_superset_line" in
        *'"dir":"from_tui"'*'"kind":"op"'*'"UserTurn"'*)
          _superset_emit_event "Start"
          ;;
        *'"dir":"to_tui"'*'"kind":"codex_event"'*'"msg":{"type":"task_started"'*)
          _superset_turn_id=$(printf '%s\n' "$_superset_line" | awk -F'"turn_id":"' 'NF > 1 { sub(/".*/, "", $2); print $2; exit }')
          [ -n "$_superset_turn_id" ] || _superset_turn_id="task_started"
          if [ "$_superset_turn_id" != "$_superset_last_turn_id" ]; then
            _superset_last_turn_id="$_superset_turn_id"
            _superset_emit_event "Start"
          fi
          ;;
        *'"dir":"to_tui"'*'"kind":"codex_event"'*'"msg":{"type":"exec_command_begin"'*)
          _superset_exec_call_id=$(printf '%s\n' "$_superset_line" | awk -F'"call_id":"' 'NF > 1 { sub(/".*/, "", $2); print $2; exit }')
          if [ -n "$_superset_exec_call_id" ]; then
            if [ "$_superset_exec_call_id" != "$_superset_last_exec_call_id" ]; then
              _superset_last_exec_call_id="$_superset_exec_call_id"
              _superset_emit_event "Start"
            fi
          else
            _superset_emit_event "Start"
          fi
          ;;
        *'_approval_request"'*)
          _superset_approval_id=$(printf '%s\n' "$_superset_line" | awk -F'"id":"' 'NF > 1 { sub(/".*/, "", $2); print $2; exit }')
          [ -n "$_superset_approval_id" ] || _superset_approval_id=$(printf '%s\n' "$_superset_line" | awk -F'"approval_id":"' 'NF > 1 { sub(/".*/, "", $2); print $2; exit }')
          [ -n "$_superset_approval_id" ] || _superset_approval_id=$(printf '%s\n' "$_superset_line" | awk -F'"call_id":"' 'NF > 1 { sub(/".*/, "", $2); print $2; exit }')
          if [ -z "$_superset_approval_id" ]; then
            _superset_approval_fallback_seq=$((_superset_approval_fallback_seq + 1))
            _superset_approval_id="approval_request_${_superset_approval_fallback_seq}"
          fi
          if [ "$_superset_approval_id" != "$_superset_last_approval_id" ]; then
            _superset_last_approval_id="$_superset_approval_id"
            _superset_emit_event "PermissionRequest"
          fi
          ;;
      esac
    done
  ) 2>/dev/null &
  SUPERSET_CODEX_SESSION_WATCHER_PID=$!
  _superset_debug "session watcher pid=$SUPERSET_CODEX_SESSION_WATCHER_PID"
else
  _superset_notify_exists="0"
  [ -f "$_superset_notify_path" ] && _superset_notify_exists="1"
  _superset_debug "session watcher disabled hasSupersetContext=$_superset_has_superset_context terminalId=$SUPERSET_TERMINAL_ID tabId=$SUPERSET_TAB_ID paneId=$SUPERSET_PANE_ID notifyExists=$_superset_notify_exists notify=$_superset_notify_path"
fi

# `hooks` (formerly `codex_hooks`) is stable and default-enabled in codex
# >=0.129; the legacy `notify=...` callback remains the completion source.
"$REAL_BIN" "${_superset_codex_args[@]}" --enable hooks -c 'notify=["bash","{{NOTIFY_PATH}}"]' "$@"
SUPERSET_CODEX_STATUS=$?
_superset_debug "codex exited status=$SUPERSET_CODEX_STATUS"

_superset_cleanup_session_watcher

trap - EXIT HUP INT TERM
exit "$SUPERSET_CODEX_STATUS"
