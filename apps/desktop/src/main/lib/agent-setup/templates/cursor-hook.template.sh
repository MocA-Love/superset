#!/bin/bash
{{MARKER}}
# Called by cursor-agent hooks to notify Superset of agent lifecycle events
# Events: Start (beforeSubmitPrompt), Stop (stop),
#         PermissionRequest (beforeShellExecution, beforeMCPExecution)

# Drain stdin — Cursor pipes JSON context that we don't need, but we must consume it
# to prevent broken-pipe errors from blocking the agent
cat > /dev/null 2>&1

EVENT_TYPE="$1"

# Map event type and determine if we need to respond with JSON
NEEDS_RESPONSE=false
case "$EVENT_TYPE" in
  Start|Stop) ;;
  PermissionRequest) NEEDS_RESPONSE=true ;;
  *) exit 0 ;;
esac

# For permission hooks, auto-approve by writing JSON to stdout
# This must happen before any exit to avoid blocking the agent
if [ "$NEEDS_RESPONSE" = "true" ]; then
  printf '{"continue":true}\n'
fi

# cursor-agent runs inside a Superset terminal, so env vars are inherited directly
[ -z "$SUPERSET_TAB_ID" ] && exit 0

if [ -n "$SUPERSET_WRAPPER_PID" ] && [ "$SUPERSET_PREVENT_AGENT_SLEEP" = "1" ] && [ "$(uname -s 2>/dev/null)" = "Darwin" ] && command -v caffeinate >/dev/null 2>&1; then
  _superset_sleep_dir="${TMPDIR:-/tmp}/superset-sleep-inhibitors"
  mkdir -p "$_superset_sleep_dir" >/dev/null 2>&1 || true
  _superset_pid_file="$_superset_sleep_dir/${SUPERSET_WRAPPER_PID}.pid"
  case "$EVENT_TYPE" in
    Start|PermissionRequest)
      if [ -f "$_superset_pid_file" ]; then
        _superset_caffeinate_pid=$(cat "$_superset_pid_file" 2>/dev/null)
        if [ -n "$_superset_caffeinate_pid" ] && kill -0 "$_superset_caffeinate_pid" 2>/dev/null; then
          :
        else
          rm -f "$_superset_pid_file" >/dev/null 2>&1 || true
          if kill -0 "$SUPERSET_WRAPPER_PID" 2>/dev/null; then
            caffeinate -i -w "$SUPERSET_WRAPPER_PID" >/dev/null 2>&1 &
            echo "$!" > "$_superset_pid_file"
          fi
        fi
      elif kill -0 "$SUPERSET_WRAPPER_PID" 2>/dev/null; then
        caffeinate -i -w "$SUPERSET_WRAPPER_PID" >/dev/null 2>&1 &
        echo "$!" > "$_superset_pid_file"
      fi
      ;;
    Stop)
      if [ -f "$_superset_pid_file" ]; then
        _superset_caffeinate_pid=$(cat "$_superset_pid_file" 2>/dev/null)
        if [ -n "$_superset_caffeinate_pid" ] && kill -0 "$_superset_caffeinate_pid" 2>/dev/null; then
          kill "$_superset_caffeinate_pid" >/dev/null 2>&1 || true
        fi
        rm -f "$_superset_pid_file" >/dev/null 2>&1 || true
      fi
      ;;
  esac
fi

curl -sG "http://127.0.0.1:${SUPERSET_PORT:-{{DEFAULT_PORT}}}/hook/complete" \
  --connect-timeout 1 --max-time 2 \
  --data-urlencode "paneId=$SUPERSET_PANE_ID" \
  --data-urlencode "tabId=$SUPERSET_TAB_ID" \
  --data-urlencode "workspaceId=$SUPERSET_WORKSPACE_ID" \
  --data-urlencode "eventType=$EVENT_TYPE" \
  --data-urlencode "env=$SUPERSET_ENV" \
  --data-urlencode "version=$SUPERSET_HOOK_VERSION" \
  > /dev/null 2>&1

exit 0
