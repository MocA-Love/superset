import { readFile } from "node:fs/promises";
import path from "node:path";
import { glob } from "fast-glob";
import type { ChromeManifest } from "./crx-downloader";

/** APIs fully supported in Electron */
const SUPPORTED_APIS = new Set([
	"chrome.devtools.inspectedWindow",
	"chrome.devtools.network",
	"chrome.devtools.panels",
	"chrome.scripting",
	"chrome.webRequest",
	"chrome.storage.local",
	"chrome.runtime.lastError",
	"chrome.runtime.id",
	"chrome.runtime.getManifest",
	"chrome.runtime.getURL",
	"chrome.runtime.connect",
	"chrome.runtime.sendMessage",
	"chrome.runtime.onConnect",
	"chrome.runtime.onMessage",
	"chrome.runtime.onInstalled",
	"chrome.runtime.onStartup",
	"chrome.extension.getURL",
	"chrome.extension.getBackgroundPage",
]);

/** Permissions that Electron cannot provide */
const UNSUPPORTED_PERMISSIONS = new Set([
	"bookmarks",
	"browsingData",
	"contentSettings",
	"cookies",
	"debugger",
	"declarativeContent",
	"declarativeNetRequest",
	"desktopCapture",
	"downloads",
	"downloads.shelf",
	"enterprise.deviceAttributes",
	"enterprise.platformKeys",
	"fontSettings",
	"gcm",
	"geolocation",
	"history",
	"identity",
	"idle",
	"loginState",
	"nativeMessaging",
	"notifications",
	"pageCapture",
	"platformKeys",
	"power",
	"printerProvider",
	"printing",
	"printingMetrics",
	"privacy",
	"proxy",
	"search",
	"sessions",
	"signedInDevices",
	"system.cpu",
	"system.display",
	"system.memory",
	"system.storage",
	"tabCapture",
	"tabGroups",
	"topSites",
	"tts",
	"ttsEngine",
	"wallpaper",
	"webNavigation",
]);

/** chrome.* API patterns that don't work in Electron */
const UNSUPPORTED_API_PATTERNS = [
	"chrome.bookmarks",
	"chrome.browsingData",
	"chrome.contentSettings",
	"chrome.cookies",
	"chrome.debugger",
	"chrome.declarativeContent",
	"chrome.declarativeNetRequest",
	"chrome.desktopCapture",
	"chrome.downloads",
	"chrome.fontSettings",
	"chrome.gcm",
	"chrome.history",
	"chrome.identity",
	"chrome.notifications",
	"chrome.pageCapture",
	"chrome.privacy",
	"chrome.proxy",
	"chrome.sessions",
	"chrome.tabCapture",
	"chrome.tabGroups",
	"chrome.topSites",
	"chrome.tts",
	"chrome.ttsEngine",
	"chrome.webNavigation",
	"chrome.storage.sync",
	"chrome.storage.managed",
	"chrome.tabs.create",
	"chrome.tabs.remove",
	"chrome.tabs.move",
	"chrome.tabs.group",
	"chrome.tabs.ungroup",
	"chrome.tabs.duplicate",
	"chrome.tabs.discard",
	"chrome.tabs.captureVisibleTab",
	"chrome.tabs.goBack",
	"chrome.tabs.goForward",
	"chrome.windows.create",
	"chrome.windows.remove",
	"chrome.windows.update",
];

export type CompatibilityLevel = "full" | "partial" | "low";

export interface CompatibilityIssue {
	type: "unsupported_permission" | "unsupported_api" | "unsupported_feature";
	severity: "warning" | "error";
	message: string;
	detail?: string;
}

export interface CompatibilityReport {
	level: CompatibilityLevel;
	issues: CompatibilityIssue[];
	summary: string;
}

/**
 * Check extension manifest for unsupported features.
 */
function checkManifest(manifest: ChromeManifest): CompatibilityIssue[] {
	const issues: CompatibilityIssue[] = [];

	// Check permissions
	const allPermissions = [
		...(manifest.permissions ?? []),
		...(manifest.optional_permissions ?? []),
	];

	for (const perm of allPermissions) {
		if (UNSUPPORTED_PERMISSIONS.has(perm)) {
			issues.push({
				type: "unsupported_permission",
				severity: "warning",
				message: `Permission "${perm}" is not supported in Electron`,
			});
		}
	}

	// Check chrome_url_overrides
	if (manifest.chrome_url_overrides) {
		issues.push({
			type: "unsupported_feature",
			severity: "error",
			message: "Chrome URL overrides (new tab, history, bookmarks pages) are not supported",
		});
	}

	// Check options_ui
	if (manifest.options_ui || manifest.options_page) {
		issues.push({
			type: "unsupported_feature",
			severity: "warning",
			message: "Options page may not work as expected",
			detail:
				"Extension options pages rely on chrome.runtime.openOptionsPage() which has limited support",
		});
	}

	return issues;
}

/**
 * Scan the extension's JS files for usage of unsupported chrome.* APIs.
 */
async function scanJsForUnsupportedApis(
	extensionDir: string,
): Promise<CompatibilityIssue[]> {
	const issues: CompatibilityIssue[] = [];
	const seen = new Set<string>();

	const jsFiles = await glob("**/*.js", {
		cwd: extensionDir,
		absolute: true,
		ignore: ["**/node_modules/**"],
	});

	for (const file of jsFiles) {
		let content: string;
		try {
			content = await readFile(file, "utf-8");
		} catch {
			continue;
		}

		for (const api of UNSUPPORTED_API_PATTERNS) {
			if (seen.has(api)) continue;

			// Escape dots for regex, match the API call pattern
			const pattern = api.replace(/\./g, "\\.");
			const regex = new RegExp(`${pattern}\\b`);

			if (regex.test(content)) {
				seen.add(api);
				issues.push({
					type: "unsupported_api",
					severity: "warning",
					message: `Uses "${api}" which is not supported in Electron`,
					detail: `Found in ${path.basename(file)}`,
				});
			}
		}
	}

	return issues;
}

/**
 * Run a full compatibility check on an unpacked extension.
 */
export async function checkCompatibility(
	extensionDir: string,
	manifest: ChromeManifest,
): Promise<CompatibilityReport> {
	const manifestIssues = checkManifest(manifest);
	const apiIssues = await scanJsForUnsupportedApis(extensionDir);

	const issues = [...manifestIssues, ...apiIssues];

	const errorCount = issues.filter((i) => i.severity === "error").length;
	const warningCount = issues.filter((i) => i.severity === "warning").length;

	let level: CompatibilityLevel;
	if (errorCount > 0 || warningCount >= 5) {
		level = "low";
	} else if (warningCount > 0) {
		level = "partial";
	} else {
		level = "full";
	}

	let summary: string;
	switch (level) {
		case "full":
			summary = "This extension is expected to work well in Electron.";
			break;
		case "partial":
			summary = `This extension may have limited functionality (${warningCount} potential issue${warningCount > 1 ? "s" : ""}).`;
			break;
		case "low":
			summary = `This extension is likely incompatible (${errorCount} critical, ${warningCount} warning${warningCount > 1 ? "s" : ""}).`;
			break;
	}

	return { level, issues, summary };
}
