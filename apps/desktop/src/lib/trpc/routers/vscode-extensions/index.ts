import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { TRPCError } from "@trpc/server";
import { observable } from "@trpc/server/observable";
import {
	getWebviewUrl,
	setWebviewHtml,
} from "main/lib/vscode-shim/api/webview-server";
import { setActiveTextEditor } from "main/lib/vscode-shim/api/window";
import {
	getActiveExtensions,
	restartExtension,
	updateWorkspacePath,
} from "main/lib/vscode-shim/extension-host";
import type { WebviewBridgeEvent } from "main/lib/vscode-shim/webview-bridge";
import { webviewBridge } from "main/lib/vscode-shim/webview-bridge";
import { z } from "zod";
import { publicProcedure, router } from "../..";

/** Known VS Code extensions that can be managed */
const KNOWN_EXTENSIONS = [
	{
		id: "anthropic.claude-code",
		name: "Claude Code",
		publisher: "Anthropic",
		description: "AI coding assistant by Anthropic",
		marketplaceUrl:
			"https://marketplace.visualstudio.com/items?itemName=anthropic.claude-code",
		viewType: "claudeVSCodeSidebar",
	},
	{
		id: "openai.chatgpt",
		name: "ChatGPT / Codex",
		publisher: "OpenAI",
		description: "AI coding assistant by OpenAI",
		marketplaceUrl:
			"https://marketplace.visualstudio.com/items?itemName=openai.chatgpt",
		viewType: "chatgpt.sidebarView",
	},
] as const;

function getExtensionsDir(): string {
	return path.join(os.homedir(), ".vscode", "extensions");
}

/** Persistent enabled/disabled state for extensions */
function getEnabledConfigPath(): string {
	const userDataPath = (() => {
		try {
			return require("electron").app.getPath("userData");
		} catch {
			return path.join(os.homedir(), ".superset-desktop");
		}
	})();
	return path.join(userDataPath, "vscode-extensions-enabled.json");
}

function readEnabledConfig(): Record<string, boolean> {
	try {
		const p = getEnabledConfigPath();
		if (fs.existsSync(p)) {
			return JSON.parse(fs.readFileSync(p, "utf-8"));
		}
	} catch {}
	// All enabled by default
	return {};
}

function writeEnabledConfig(config: Record<string, boolean>): void {
	try {
		const p = getEnabledConfigPath();
		fs.mkdirSync(path.dirname(p), { recursive: true });
		fs.writeFileSync(p, JSON.stringify(config, null, 2));
	} catch {}
}

function isExtensionEnabled(extensionId: string): boolean {
	const config = readEnabledConfig();
	return config[extensionId] !== false; // enabled by default
}

function isExtensionInstalled(extensionId: string): boolean {
	const dir = getExtensionsDir();
	if (!fs.existsSync(dir)) return false;
	const entries = fs.readdirSync(dir);
	return entries.some((entry) =>
		entry.toLowerCase().startsWith(extensionId.toLowerCase()),
	);
}

/** Wait for HTML to be set on a webview (for async providers) */
function waitForHtml(
	viewId: string,
	timeoutMs: number,
): Promise<string | null> {
	return new Promise((resolve) => {
		// Check immediately before starting poll
		const html = webviewBridge.getHtml(viewId);
		if (html) {
			resolve(html);
			return;
		}

		// Poll every 200ms
		const interval = setInterval(() => {
			const html = webviewBridge.getHtml(viewId);
			if (html) {
				clearInterval(interval);
				resolve(html);
			}
		}, 200);

		// Timeout
		setTimeout(() => {
			clearInterval(interval);
			console.warn(
				`[vscode-shim] waitForHtml timed out after ${timeoutMs}ms for ${viewId}`,
			);
			resolve(null);
		}, timeoutMs);
	});
}

/**
 * Download a VS Code extension from the marketplace and extract to extensions dir.
 * Uses the VS Code Marketplace Gallery API to fetch the .vsix package.
 */
async function downloadAndInstallExtension(extensionId: string): Promise<void> {
	// Validate against known extensions whitelist
	if (!KNOWN_EXTENSIONS.some((e) => e.id === extensionId)) {
		throw new Error(`Unknown extension: ${extensionId}`);
	}

	// Strict format validation
	if (!/^[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+$/.test(extensionId)) {
		throw new Error(`Invalid extension ID format: ${extensionId}`);
	}

	const [publisher, name] = extensionId.split(".");
	if (!publisher || !name) {
		throw new Error(`Invalid extension ID: ${extensionId}`);
	}

	const extensionsDir = getExtensionsDir();
	fs.mkdirSync(extensionsDir, { recursive: true });

	// Step 1: Query marketplace for latest version + download URL
	const queryBody = JSON.stringify({
		filters: [
			{
				criteria: [{ filterType: 7, value: `${publisher}.${name}` }],
			},
		],
		flags: 0x200 | 0x1, // IncludeFiles | IncludeVersions
	});

	const queryResponse = await fetch(
		"https://marketplace.visualstudio.com/_apis/public/gallery/extensionquery",
		{
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Accept: "application/json;api-version=6.0-preview.1",
			},
			body: queryBody,
		},
	);

	if (!queryResponse.ok) {
		throw new Error(`Marketplace query failed: ${queryResponse.status}`);
	}

	const queryData = (await queryResponse.json()) as {
		results: Array<{
			extensions: Array<{
				versions: Array<{
					version: string;
					targetPlatform?: string;
					files: Array<{ assetType: string; source: string }>;
				}>;
			}>;
		}>;
	};

	const ext = queryData.results?.[0]?.extensions?.[0];
	if (!ext) {
		throw new Error(`Extension not found: ${extensionId}`);
	}

	// Find the best matching version (prefer platform-specific)
	const platform = `${process.platform}-${process.arch}`;
	const platformVersion = ext.versions.find(
		(v) => v.targetPlatform === platform,
	);
	const universalVersion = ext.versions.find(
		(v) => !v.targetPlatform || v.targetPlatform === "universal",
	);
	const version = platformVersion ?? universalVersion ?? ext.versions[0];
	if (!version) {
		throw new Error(`No version found for ${extensionId}`);
	}

	// Find VSIX download URL
	const vsixAsset = version.files.find(
		(f) => f.assetType === "Microsoft.VisualStudio.Services.VSIXPackage",
	);
	if (!vsixAsset) {
		throw new Error(`No VSIX package found for ${extensionId}`);
	}

	console.log(
		`[vscode-shim] Downloading ${extensionId}@${version.version} (${version.targetPlatform ?? "universal"})`,
	);

	// Step 2: Download .vsix
	const vsixResponse = await fetch(vsixAsset.source);
	if (!vsixResponse.ok || !vsixResponse.body) {
		throw new Error(`VSIX download failed: ${vsixResponse.status}`);
	}

	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vscode-ext-"));
	const vsixPath = path.join(tmpDir, `${extensionId}.vsix`);

	const fileStream = fs.createWriteStream(vsixPath);
	// @ts-expect-error - Node fetch body is a ReadableStream
	await pipeline(vsixResponse.body, fileStream);

	// Step 3: Extract .vsix (it's a zip file)
	const targetSuffix = version.targetPlatform
		? `-${version.targetPlatform}`
		: "";
	const extDir = path.join(
		extensionsDir,
		`${publisher}.${name}-${version.version}${targetSuffix}`,
	);

	try {
		if (fs.existsSync(extDir)) {
			fs.rmSync(extDir, { recursive: true });
		}
		fs.mkdirSync(extDir, { recursive: true });

		// Extract .vsix using spawnSync (no shell injection risk)
		const extractDir = path.join(tmpDir, "extracted");
		const unzipResult = spawnSync(
			"unzip",
			["-q", "-o", vsixPath, "-d", extractDir],
			{
				stdio: "pipe",
			},
		);
		if (unzipResult.status !== 0) {
			throw new Error(`unzip failed: ${unzipResult.stderr?.toString()}`);
		}

		// Copy extension content using Node.js fs (no shell commands)
		const extractedExtDir = path.join(extractDir, "extension");
		if (fs.existsSync(extractedExtDir)) {
			fs.cpSync(extractedExtDir, extDir, { recursive: true });
		}

		// Copy vsixmanifest if present
		const vsixManifest = path.join(extractDir, "extension.vsixmanifest");
		if (fs.existsSync(vsixManifest)) {
			fs.copyFileSync(vsixManifest, path.join(extDir, ".vsixmanifest"));
		}

		console.log(`[vscode-shim] Installed ${extensionId} to ${extDir}`);
	} finally {
		// Always cleanup temp directory
		fs.rmSync(tmpDir, { recursive: true, force: true });
	}
}

export const createVscodeExtensionsRouter = () => {
	return router({
		/** Get list of loaded (active) extensions */
		getExtensions: publicProcedure.query(() => {
			return getActiveExtensions();
		}),

		/** Get all known extensions with their install/active status */
		getKnownExtensions: publicProcedure.query(() => {
			let activeExtensions: Array<{ id: string; isActive: boolean }> = [];
			try {
				activeExtensions = getActiveExtensions();
			} catch {}

			return KNOWN_EXTENSIONS.map((ext) => {
				const active = activeExtensions.find((a) => a.id === ext.id);
				return {
					...ext,
					installed: isExtensionInstalled(ext.id),
					enabled: isExtensionEnabled(ext.id),
					active: active?.isActive ?? false,
				};
			});
		}),

		/** Resolve a webview view for a given viewType, returns viewId + HTML */
		resolveWebview: publicProcedure
			.input(
				z.object({
					viewType: z.string(),
					extensionPath: z.string(),
				}),
			)
			.mutation(async ({ input }) => {
				const viewId = webviewBridge.resolveView(
					input.viewType,
					input.extensionPath,
				);
				if (!viewId) {
					return { viewId: null, url: null };
				}
				// Wait for HTML if provider sets it asynchronously
				let html = webviewBridge.getHtml(viewId);
				if (!html) {
					console.log(
						`[vscode-shim] resolveWebview: waiting for async HTML on ${viewId}`,
					);
					html = (await waitForHtml(viewId, 5000)) ?? undefined;
				}
				if (html) {
					setWebviewHtml(viewId, html);
				}
				const url = getWebviewUrl(viewId);
				console.log(
					`[vscode-shim] resolveWebview: viewId=${viewId}, hasHtml=${!!html}, url=${url}`,
				);
				return { viewId, url };
			}),

		/** Get current webview HTML */
		getWebviewHtml: publicProcedure
			.input(z.object({ viewType: z.string() }))
			.query(({ input }) => {
				const viewId = webviewBridge.getViewId(input.viewType);
				if (!viewId) return null;
				return webviewBridge.getHtml(viewId) ?? null;
			}),

		/** Send a message from renderer to extension webview */
		postMessageToExtension: publicProcedure
			.input(
				z.object({
					viewId: z.string(),
					message: z.unknown(),
				}),
			)
			.mutation(({ input }) => {
				webviewBridge.postMessageToExtension(input.viewId, input.message);
				return { success: true };
			}),

		/** Enable or disable an extension (persisted, requires restart for full effect) */
		setExtensionEnabled: publicProcedure
			.input(
				z.object({
					extensionId: z.string(),
					enabled: z.boolean(),
				}),
			)
			.mutation(async ({ input }) => {
				if (!KNOWN_EXTENSIONS.some((e) => e.id === input.extensionId)) {
					throw new TRPCError({
						code: "BAD_REQUEST",
						message: "Unknown extension",
					});
				}
				const config = readEnabledConfig();
				config[input.extensionId] = input.enabled;
				writeEnabledConfig(config);

				// If disabling, deactivate immediately
				if (!input.enabled) {
					try {
						const { deactivateExtension } = await import(
							"main/lib/vscode-shim/loader"
						);
						await deactivateExtension(input.extensionId);
					} catch {}
				}

				return { success: true, needsRestart: true };
			}),

		/** Set the workspace folder path for extensions */
		setWorkspacePath: publicProcedure
			.input(z.object({ workspacePath: z.string() }))
			.mutation(({ input }) => {
				updateWorkspacePath(input.workspacePath);
				return { success: true };
			}),

		/** Notify main process of active file change (for activeTextEditor) */
		setActiveEditor: publicProcedure
			.input(
				z.object({
					filePath: z.string().nullable(),
					languageId: z.string().optional(),
				}),
			)
			.mutation(({ input }) => {
				setActiveTextEditor(input.filePath, input.languageId);
				return { success: true };
			}),

		/** Download and install an extension from the VS Code Marketplace */
		installExtension: publicProcedure
			.input(z.object({ extensionId: z.string() }))
			.mutation(async ({ input }) => {
				await downloadAndInstallExtension(input.extensionId);
				return { success: true };
			}),

		/** Restart a specific extension */
		restartExtension: publicProcedure
			.input(z.object({ extensionId: z.string() }))
			.mutation(async ({ input }) => {
				const success = await restartExtension(input.extensionId);
				return { success };
			}),

		/** Subscribe to webview events (HTML changes, messages from extension) */
		subscribeWebview: publicProcedure.subscription(() => {
			return observable<WebviewBridgeEvent>((emit) => {
				const handler = (event: WebviewBridgeEvent) => {
					emit.next(event);
				};
				webviewBridge.on("webview-event", handler);
				return () => {
					webviewBridge.off("webview-event", handler);
				};
			});
		}),
	});
};
