#!/bin/bash
{{MARKER}}
# Called by CLI agents (Claude Code, Codex, etc.) when they complete or need input

# Get JSON input - Codex passes as argument, Claude pipes to stdin
if [ -n "$1" ]; then
  INPUT="$1"
else
  INPUT=$(cat)
fi

# Extract Mastra identifiers when available (mastracode hooks)
# `resourceId` / `resource_id` is the Superset chat session id we assign via
# harness.setResourceId(...). `session_id` is Mastra's internal runtime id.
HOOK_SESSION_ID=$(echo "$INPUT" | grep -oE '"session_id"[[:space:]]*:[[:space:]]*"[^"]*"' | grep -oE '"[^"]*"$' | tr -d '"')
RESOURCE_ID=$(echo "$INPUT" | grep -oE '"resourceId"[[:space:]]*:[[:space:]]*"[^"]*"' | grep -oE '"[^"]*"$' | tr -d '"')
if [ -z "$RESOURCE_ID" ]; then
  RESOURCE_ID=$(echo "$INPUT" | grep -oE '"resource_id"[[:space:]]*:[[:space:]]*"[^"]*"' | grep -oE '"[^"]*"$' | tr -d '"')
fi
SESSION_ID=${RESOURCE_ID:-$HOOK_SESSION_ID}

# Skip if this isn't a Superset terminal hook and no Mastra session context exists
[ -z "$SUPERSET_TAB_ID" ] && [ -z "$SESSION_ID" ] && exit 0

# Extract event type - Claude uses "hook_event_name", Codex uses "type"
# Use flexible pattern to handle optional whitespace: "key": "value" or "key":"value"
EVENT_TYPE=$(echo "$INPUT" | grep -oE '"hook_event_name"[[:space:]]*:[[:space:]]*"[^"]*"' | grep -oE '"[^"]*"$' | tr -d '"')
if [ -z "$EVENT_TYPE" ]; then
  # Check for Codex "type" field when no native hook_event_name is present.
  CODEX_TYPE=$(echo "$INPUT" | grep -oE '"type"[[:space:]]*:[[:space:]]*"[^"]*"' | grep -oE '"[^"]*"$' | tr -d '"')
  case "$CODEX_TYPE" in
    agent-turn-complete|task_complete)
      EVENT_TYPE="Stop"
      ;;
    task_started)
      EVENT_TYPE="Start"
      ;;
    exec_approval_request|apply_patch_approval_request|request_user_input)
      EVENT_TYPE="PermissionRequest"
      ;;
  esac
fi

# NOTE: We intentionally do NOT default to "Stop" if EVENT_TYPE is empty.
# Parse failures should not trigger completion notifications.
# The server will ignore requests with missing eventType (forward compatibility).

# Only UserPromptSubmit is mapped here; other events are normalized
# server-side by mapEventType() to keep a single source of truth.
[ "$EVENT_TYPE" = "UserPromptSubmit" ] && EVENT_TYPE="Start"

# If no event type was found, skip the notification
# This prevents parse failures from causing false completion notifications
[ -z "$EVENT_TYPE" ] && exit 0

_superset_manage_sleep_inhibitor() {
  [ -n "$SUPERSET_WRAPPER_PID" ] || return 0
  [ "$SUPERSET_PREVENT_AGENT_SLEEP" = "1" ] || return 0
  [ "$(uname -s 2>/dev/null)" = "Darwin" ] || return 0
  command -v caffeinate >/dev/null 2>&1 || return 0

  _superset_sleep_dir="${TMPDIR:-/tmp}/superset-sleep-inhibitors"
  mkdir -p "$_superset_sleep_dir" >/dev/null 2>&1 || return 0
  _superset_pid_file="$_superset_sleep_dir/${SUPERSET_WRAPPER_PID}.pid"

  case "$EVENT_TYPE" in
    Start|PermissionRequest)
      if [ -f "$_superset_pid_file" ]; then
        _superset_caffeinate_pid=$(cat "$_superset_pid_file" 2>/dev/null)
        if [ -n "$_superset_caffeinate_pid" ] && kill -0 "$_superset_caffeinate_pid" 2>/dev/null; then
          return 0
        fi
        rm -f "$_superset_pid_file" >/dev/null 2>&1 || true
      fi
      kill -0 "$SUPERSET_WRAPPER_PID" 2>/dev/null || return 0
      caffeinate -i -w "$SUPERSET_WRAPPER_PID" >/dev/null 2>&1 &
      echo "$!" > "$_superset_pid_file"
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
}

_superset_manage_sleep_inhibitor

DEBUG_HOOKS_ENABLED="0"
if [ -n "$SUPERSET_DEBUG_HOOKS" ]; then
  case "$SUPERSET_DEBUG_HOOKS" in
    1|true|TRUE|True|yes|YES|on|ON)
      DEBUG_HOOKS_ENABLED="1"
      ;;
    *)
      DEBUG_HOOKS_ENABLED="0"
      ;;
  esac
elif [ "$SUPERSET_ENV" = "development" ] || [ "$NODE_ENV" = "development" ]; then
  DEBUG_HOOKS_ENABLED="1"
fi

if [ "$DEBUG_HOOKS_ENABLED" = "1" ]; then
  echo "[notify-hook] event=$EVENT_TYPE sessionId=$SESSION_ID hookSessionId=$HOOK_SESSION_ID resourceId=$RESOURCE_ID paneId=$SUPERSET_PANE_ID tabId=$SUPERSET_TAB_ID workspaceId=$SUPERSET_WORKSPACE_ID wrapperPid=$SUPERSET_WRAPPER_PID" >&2
fi

# Timeouts prevent blocking agent completion if notification server is unresponsive
if [ "$DEBUG_HOOKS_ENABLED" = "1" ]; then
  STATUS_CODE=$(curl -sG "http://127.0.0.1:${SUPERSET_PORT:-{{DEFAULT_PORT}}}/hook/complete" \
    --connect-timeout 1 --max-time 2 \
    --data-urlencode "paneId=$SUPERSET_PANE_ID" \
    --data-urlencode "tabId=$SUPERSET_TAB_ID" \
    --data-urlencode "workspaceId=$SUPERSET_WORKSPACE_ID" \
    --data-urlencode "sessionId=$SESSION_ID" \
    --data-urlencode "hookSessionId=$HOOK_SESSION_ID" \
    --data-urlencode "resourceId=$RESOURCE_ID" \
    --data-urlencode "eventType=$EVENT_TYPE" \
    --data-urlencode "env=$SUPERSET_ENV" \
    --data-urlencode "version=$SUPERSET_HOOK_VERSION" \
    -o /dev/null -w "%{http_code}" 2>/dev/null)
  echo "[notify-hook] dispatched status=$STATUS_CODE" >&2
else
  curl -sG "http://127.0.0.1:${SUPERSET_PORT:-{{DEFAULT_PORT}}}/hook/complete" \
    --connect-timeout 1 --max-time 2 \
    --data-urlencode "paneId=$SUPERSET_PANE_ID" \
    --data-urlencode "tabId=$SUPERSET_TAB_ID" \
    --data-urlencode "workspaceId=$SUPERSET_WORKSPACE_ID" \
    --data-urlencode "sessionId=$SESSION_ID" \
    --data-urlencode "hookSessionId=$HOOK_SESSION_ID" \
    --data-urlencode "resourceId=$RESOURCE_ID" \
    --data-urlencode "eventType=$EVENT_TYPE" \
    --data-urlencode "env=$SUPERSET_ENV" \
    --data-urlencode "version=$SUPERSET_HOOK_VERSION" \
    > /dev/null 2>&1
fi

exit 0
