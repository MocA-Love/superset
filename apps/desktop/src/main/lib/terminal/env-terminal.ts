import fs from "node:fs";
import os from "node:os";
import { settings } from "@superset/local-db";
import { DEFAULT_PREVENT_AGENT_SLEEP } from "shared/constants";
import { env } from "shared/env.shared";
import { getShellEnv } from "../agent-setup/shell-wrappers";
import { localDb } from "../local-db";
import {
	buildSafeEnv,
	getLocale,
	HOOK_PROTOCOL_VERSION,
	sanitizeEnv,
} from "./env";

const MACOS_SYSTEM_CERT_FILE = "/etc/ssl/cert.pem";
const PROCESS_ENV_SNAPSHOT_CACHE_TTL_MS = 1_000;

let cachedProcessEnvSnapshot: {
	raw: Record<string, string>;
	safe: Record<string, string>;
	expiresAt: number;
} | null = null;
let cachedMacosSystemCertAvailable: boolean | null = null;

function getProcessEnvSnapshot(): {
	raw: Record<string, string>;
	safe: Record<string, string>;
} {
	const now = Date.now();
	if (cachedProcessEnvSnapshot && cachedProcessEnvSnapshot.expiresAt > now) {
		return cachedProcessEnvSnapshot;
	}

	const raw = sanitizeEnv(process.env) || {};
	const safe = buildSafeEnv(raw);
	cachedProcessEnvSnapshot = {
		raw,
		safe,
		expiresAt: now + PROCESS_ENV_SNAPSHOT_CACHE_TTL_MS,
	};
	return cachedProcessEnvSnapshot;
}

function hasMacosSystemCertBundle(): boolean {
	if (cachedMacosSystemCertAvailable !== null) {
		return cachedMacosSystemCertAvailable;
	}

	cachedMacosSystemCertAvailable = fs.existsSync(MACOS_SYSTEM_CERT_FILE);
	return cachedMacosSystemCertAvailable;
}

export function resetTerminalEnvCachesForTests(): void {
	cachedProcessEnvSnapshot = null;
	cachedMacosSystemCertAvailable = null;
}

/**
 * @deprecated Use buildSafeEnv instead. Kept for backward compatibility.
 */
export function removeAppEnvVars(
	env: Record<string, string>,
): Record<string, string> {
	return buildSafeEnv(env);
}

export function buildTerminalEnv(params: {
	shell: string;
	paneId: string;
	tabId: string;
	workspaceId: string;
	workspaceName?: string;
	workspacePath?: string;
	rootPath?: string;
	themeType?: "dark" | "light";
}): Record<string, string> {
	const {
		shell,
		paneId,
		tabId,
		workspaceId,
		workspaceName,
		workspacePath,
		rootPath,
		themeType,
	} = params;

	// Get Electron's process.env and filter to only allowlisted safe vars
	// This prevents secrets and app config from leaking to user terminals
	const { raw: rawBaseEnv, safe: baseEnv } = getProcessEnvSnapshot();

	// shellEnv provides shell wrapper control variables (ZDOTDIR, BASH_ENV, etc.)
	// These configure how the shell initializes, not the user's actual environment
	const shellEnv = getShellEnv(shell);
	const locale = getLocale(rawBaseEnv);

	// COLORFGBG: "foreground;background" ANSI color indices — TUI apps use this to detect light/dark
	const colorFgBg = themeType === "light" ? "0;15" : "15;0";
	const preventAgentSleepSetting =
		localDb.select().from(settings).get()?.preventAgentSleep ??
		DEFAULT_PREVENT_AGENT_SLEEP;

	const terminalEnv: Record<string, string> = {
		...baseEnv,
		...shellEnv,
		TERM_PROGRAM: "Superset",
		TERM_PROGRAM_VERSION: process.env.npm_package_version || "1.0.0",
		COLORTERM: "truecolor",
		COLORFGBG: colorFgBg,
		LANG: locale,
		// Browser-MCP bridge discovery: propagate the resolved Superset home
		// dir so MCP servers spawned by claude/codex in this terminal read
		// the correct workspace-scoped browser-mcp.json.
		SUPERSET_HOME_DIR:
			process.env.SUPERSET_HOME_DIR ?? shellEnv.SUPERSET_HOME_DIR ?? "",
		SUPERSET_PANE_ID: paneId,
		SUPERSET_TAB_ID: tabId,
		SUPERSET_WORKSPACE_ID: workspaceId,
		SUPERSET_WORKSPACE_NAME: workspaceName || "",
		SUPERSET_WORKSPACE_PATH: workspacePath || "",
		SUPERSET_ROOT_PATH: rootPath || "",
		SUPERSET_PORT: String(env.DESKTOP_NOTIFICATIONS_PORT),
		// Environment identifier for dev/prod separation
		SUPERSET_ENV: env.NODE_ENV === "development" ? "development" : "production",
		// Hook protocol version for forward compatibility
		SUPERSET_HOOK_VERSION: HOOK_PROTOCOL_VERSION,
		SUPERSET_PREVENT_AGENT_SLEEP: preventAgentSleepSetting ? "1" : "0",
	};

	delete terminalEnv.GOOGLE_API_KEY;

	// Electron child processes can't access macOS Keychain for TLS cert verification,
	// causing "x509: OSStatus -26276" in Go binaries like `gh`. File-based fallback.
	if (
		os.platform() === "darwin" &&
		!terminalEnv.SSL_CERT_FILE &&
		hasMacosSystemCertBundle()
	) {
		terminalEnv.SSL_CERT_FILE = MACOS_SYSTEM_CERT_FILE;
	}

	return terminalEnv;
}
