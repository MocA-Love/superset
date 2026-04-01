#!/bin/bash
{{MARKER}}
# Called by GitHub Copilot CLI hooks to notify Superset of agent lifecycle events
# Events: sessionStart → Start, sessionEnd → Stop, userPromptSubmitted → Start,
#         postToolUse → Start, preToolUse → PermissionRequest
# Copilot CLI hooks receive JSON via stdin and MUST output valid JSON to stdout

# Drain stdin — Copilot pipes JSON context that we don't need, but we must
# consume it to prevent broken-pipe errors from blocking the agent
cat > /dev/null 2>&1

# Event name is passed as $1 from our hooks.json bash command
EVENT_TYPE="$1"

case "$EVENT_TYPE" in
  sessionStart)         EVENT_TYPE="Start" ;;
  sessionEnd)           EVENT_TYPE="Stop" ;;
  userPromptSubmitted)  EVENT_TYPE="Start" ;;
  postToolUse)          EVENT_TYPE="Start" ;;
  preToolUse)           EVENT_TYPE="PermissionRequest" ;;
  *)
    printf '{}\n'
    exit 0
    ;;
esac

# Must output valid JSON to avoid blocking the agent
printf '{}\n'

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
