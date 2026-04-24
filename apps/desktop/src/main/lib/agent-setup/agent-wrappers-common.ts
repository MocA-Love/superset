import fs from "node:fs";
import path from "node:path";
import { SUPERSET_MANAGED_BINARIES } from "./desktop-agent-capabilities";
import { BIN_DIR } from "./paths";

export const WRAPPER_MARKER = "# Superset agent-wrapper v1";
export { SUPERSET_MANAGED_BINARIES };

export const IS_WIN_AGENT = process.platform === "win32";

/** Extension used for the concrete hook script on the host platform. */
export function hookScriptExtension(): "ps1" | "sh" {
	return IS_WIN_AGENT ? "ps1" : "sh";
}

/** Extension used for the bundled template shipped alongside the app. */
export function hookTemplateExtension(): "ps1" | "sh" {
	return IS_WIN_AGENT ? "ps1" : "sh";
}

/**
 * Build the shell invocation used inside agent hook configs (hooks.json,
 * settings.json, project-level hook files, etc.). On Windows we must go
 * through `powershell.exe -NoProfile -ExecutionPolicy Bypass -File` because
 * .ps1 files are not directly executable from foreign runtimes and the
 * per-user execution policy would otherwise block unsigned scripts.
 */
export function buildHookCommand(
	hookScriptPath: string,
	...args: string[]
): string {
	const quotedArgs = args.map((arg) => `"${arg}"`).join(" ");
	if (IS_WIN_AGENT) {
		return `powershell.exe -NoProfile -ExecutionPolicy Bypass -File "${hookScriptPath}"${
			quotedArgs ? ` ${quotedArgs}` : ""
		}`;
	}
	return quotedArgs ? `${hookScriptPath} ${quotedArgs}` : hookScriptPath;
}

// Dev setup (.superset/lib/setup/steps.sh) points SUPERSET_HOME_DIR at
// $PWD/superset-dev-data — without a leading dot — so we must recognize that
// variant to reap stale notify.sh paths from deleted worktrees.
const SUPERSET_MANAGED_HOOK_PATH_PATTERN =
	/\/(?:\.superset(?:-[^/'"\s\\]+)?|superset-dev-data)\//;

export function writeFileIfChanged(
	filePath: string,
	content: string,
	mode: number,
): boolean {
	const existing = fs.existsSync(filePath)
		? fs.readFileSync(filePath, "utf-8")
		: null;
	if (existing === content) {
		try {
			fs.chmodSync(filePath, mode);
		} catch {
			// Best effort.
		}
		return false;
	}

	fs.writeFileSync(filePath, content, { mode });
	return true;
}

export function isSupersetManagedHookCommand(
	command: string | undefined,
	scriptName: string,
): boolean {
	if (!command) return false;
	const normalized = command.replaceAll("\\", "/");
	if (!normalized.includes(`/hooks/${scriptName}`)) return false;
	return SUPERSET_MANAGED_HOOK_PATH_PATTERN.test(normalized);
}

interface ReconcileManagedEntriesOptions<T> {
	current: T[] | undefined;
	desired: T[];
	isManaged: (entry: T) => boolean;
	isEquivalent: (entry: T, desiredEntry: T) => boolean;
}

interface ReconcileManagedEntriesResult<T> {
	entries: T[];
	replacedManagedEntries: T[];
}

export function reconcileManagedEntries<T>({
	current,
	desired,
	isManaged,
	isEquivalent,
}: ReconcileManagedEntriesOptions<T>): ReconcileManagedEntriesResult<T> {
	const existing = Array.isArray(current) ? current : [];
	const entries: T[] = [];
	const replacedManagedEntries: T[] = [];

	for (const entry of existing) {
		if (!isManaged(entry)) {
			entries.push(entry);
			continue;
		}

		if (!desired.some((desiredEntry) => isEquivalent(entry, desiredEntry))) {
			replacedManagedEntries.push(entry);
		}
	}

	entries.push(...desired);

	return { entries, replacedManagedEntries };
}

function buildRealBinaryResolver(): string {
	return `find_real_binary() {
  local name="$1"
  local IFS=:
  for dir in $PATH; do
    [ -z "$dir" ] && continue
    dir="\${dir%/}"
    case "$dir" in
      "${BIN_DIR}"|"$HOME"/.superset/bin|"$HOME"/.superset-*/bin) continue ;;
    esac
    if [ -x "$dir/$name" ] && [ ! -d "$dir/$name" ]; then
      printf "%s\\n" "$dir/$name"
      return 0
    fi
  done
  return 1
}
`;
}

function getMissingBinaryMessage(name: string): string {
	return `Superset: ${name} not found in PATH. Install it and ensure it is on PATH, then retry.`;
}

export function getWrapperPath(binaryName: string): string {
	return path.join(BIN_DIR, binaryName);
}

export function buildWrapperScript(
	binaryName: string,
	execLine: string,
): string {
	return `#!/bin/bash
${WRAPPER_MARKER}
# Superset wrapper for ${binaryName}

${buildRealBinaryResolver()}
REAL_BIN="$(find_real_binary "${binaryName}")"
if [ -z "$REAL_BIN" ]; then
  echo "${getMissingBinaryMessage(binaryName)}" >&2
  exit 127
fi

export SUPERSET_WRAPPER_PID="$$"

${execLine}
`;
}

/**
 * Platform-aware snippet embedded into agent hook templates. Windows hooks
 * rely on the main process's powerSaveBlocker instead (#273 follow-up).
 */
export function getSleepInhibitorSnippet(): string {
	return IS_WIN_AGENT ? "" : getSleepInhibitorShellSnippet();
}

export function getSleepInhibitorShellSnippet(): string {
	return `_superset_manage_sleep_inhibitor() {
  [ -n "$SUPERSET_WRAPPER_PID" ] || return 0
  [ "$SUPERSET_PREVENT_AGENT_SLEEP" = "1" ] || return 0

  _superset_platform="$(uname -s 2>/dev/null)"
  case "$_superset_platform" in
    Darwin)
      command -v caffeinate >/dev/null 2>&1 || return 0
      ;;
    Linux)
      command -v systemd-inhibit >/dev/null 2>&1 || return 0
      ;;
    *)
      return 0
      ;;
  esac

  _superset_sleep_dir="\${TMPDIR:-/tmp}/superset-sleep-inhibitors"
  mkdir -p "$_superset_sleep_dir" >/dev/null 2>&1 || return 0
  _superset_pid_file="$_superset_sleep_dir/\${SUPERSET_WRAPPER_PID}.pid"

  case "$EVENT_TYPE" in
    Start|PermissionRequest)
      if [ -f "$_superset_pid_file" ]; then
        _superset_inhibitor_pid=$(cat "$_superset_pid_file" 2>/dev/null)
        if [ -n "$_superset_inhibitor_pid" ] && kill -0 "$_superset_inhibitor_pid" 2>/dev/null; then
          return 0
        fi
        rm -f "$_superset_pid_file" >/dev/null 2>&1 || true
      fi

      kill -0 "$SUPERSET_WRAPPER_PID" 2>/dev/null || return 0

      case "$_superset_platform" in
        Darwin)
          caffeinate -i -w "$SUPERSET_WRAPPER_PID" >/dev/null 2>&1 &
          ;;
        Linux)
          systemd-inhibit --what=idle:sleep --who="Superset" --why="Agent task in progress" \\
            /bin/sh -c 'wrapper_pid="$1"; while kill -0 "$wrapper_pid" 2>/dev/null; do sleep 15; done' \\
            _ "$SUPERSET_WRAPPER_PID" >/dev/null 2>&1 &
          ;;
      esac

      echo "$!" > "$_superset_pid_file"
      ;;
    Stop)
      if [ -f "$_superset_pid_file" ]; then
        _superset_inhibitor_pid=$(cat "$_superset_pid_file" 2>/dev/null)
        if [ -n "$_superset_inhibitor_pid" ] && kill -0 "$_superset_inhibitor_pid" 2>/dev/null; then
          kill "$_superset_inhibitor_pid" >/dev/null 2>&1 || true
        fi
        rm -f "$_superset_pid_file" >/dev/null 2>&1 || true
      fi
      ;;
  esac
}

_superset_manage_sleep_inhibitor
`;
}

export function createWrapper(binaryName: string, script: string): void {
	if (IS_WIN_AGENT) {
		// Agent wrappers are bash scripts (`#!/bin/bash` + find_real_binary).
		// Skipping them on Windows keeps agent-setup bootable while relying on
		// hooks.json / settings.json for lifecycle integration. Wrapper-driven
		// PATH injection and sleep-inhibitor are tracked as follow-ups in #273.
		return;
	}
	const changed = writeFileIfChanged(getWrapperPath(binaryName), script, 0o755);
	console.log(
		`[agent-setup] ${changed ? "Updated" : "Verified"} ${binaryName} wrapper`,
	);
}
