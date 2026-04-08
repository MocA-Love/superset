import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { TRPCError } from "@trpc/server";
import { observable } from "@trpc/server/observable";
import {
	getActivePanel,
	getActiveView,
} from "main/lib/vscode-shim/api/webview";
import {
	clearWebviewHtml,
	getWebviewUrl,
	hasWebviewHtml,
	setCustomThemeCss,
	setWebviewHtml,
} from "main/lib/vscode-shim/api/webview-server";
import { getExtensionHostManager } from "main/lib/vscode-shim/extension-host-manager";
import type { WebviewBridgeEvent } from "main/lib/vscode-shim/webview-bridge";
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
	} finally {
		// Always cleanup temp directory
		fs.rmSync(tmpDir, { recursive: true, force: true });
	}
}

async function waitForWebviewHtml(
	viewId: string,
	timeoutMs = 5000,
	pollIntervalMs = 100,
): Promise<boolean> {
	if (hasWebviewHtml(viewId)) {
		return true;
	}

	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
		if (hasWebviewHtml(viewId)) {
			return true;
		}
	}

	return hasWebviewHtml(viewId);
}

export const createVscodeExtensionsRouter = () => {
	return router({
		/** Get all known extensions with their install/active status */
		getKnownExtensions: publicProcedure.query(() => {
			const manager = getExtensionHostManager();
			const hasRunningExtensionHost =
				manager.getRunningWorkspaceIds().length > 0;
			return KNOWN_EXTENSIONS.map((ext) => {
				const installed = isExtensionInstalled(ext.id);
				const enabled = isExtensionEnabled(ext.id);
				return {
					...ext,
					installed,
					enabled,
					active: installed && enabled && hasRunningExtensionHost,
				};
			});
		}),

		/** Resolve a webview view for a given viewType, returns viewId + HTML */
		resolveWebview: publicProcedure
			.input(
				z.object({
					workspaceId: z.string(),
					workspacePath: z.string(),
					viewType: z.string(),
					extensionPath: z.string(),
				}),
			)
			.mutation(async ({ input }) => {
				const manager = getExtensionHostManager();

				// Start worker for this workspace if not already running
				if (!manager.isRunning(input.workspaceId)) {
					await manager.start(input.workspaceId, input.workspacePath);
				}

				const result = await manager.resolveWebview(
					input.workspaceId,
					input.viewType,
					input.extensionPath,
				);

				if (!result.viewId) {
					return { viewId: null, url: null };
				}

				if (result.html) {
					setWebviewHtml(result.viewId, result.html);
				}

				const url = getWebviewUrl(result.viewId);
				return { viewId: result.viewId, url };
			}),

		/** Attach to an existing webview session by viewId/panelId */
		attachWebview: publicProcedure
			.input(
				z.object({
					viewId: z.string(),
				}),
			)
			.mutation(async ({ input }) => {
				const target =
					getActiveView(input.viewId) ?? getActivePanel(input.viewId);
				if (!target) {
					return { viewId: null, url: null };
				}

				const hasHtml = await waitForWebviewHtml(input.viewId);
				if (!hasHtml) {
					return { viewId: null, url: null };
				}

				return { viewId: input.viewId, url: getWebviewUrl(input.viewId) };
			}),

		/** Dispose an existing panel-backed webview session */
		disposeWebview: publicProcedure
			.input(
				z.object({
					viewId: z.string(),
				}),
			)
			.mutation(({ input }) => {
				const panel = getActivePanel(input.viewId);
				if (!panel) {
					clearWebviewHtml(input.viewId);
					return { success: false };
				}

				panel.dispose();
				clearWebviewHtml(input.viewId);
				return { success: true };
			}),

		/** Get current webview HTML */
		getWebviewHtml: publicProcedure
			.input(z.object({ viewType: z.string() }))
			.query(() => {
				return null;
			}),

		/** Send a message from renderer to extension webview */
		postMessageToExtension: publicProcedure
			.input(
				z.object({
					workspaceId: z.string(),
					viewId: z.string(),
					message: z.unknown(),
				}),
			)
			.mutation(({ input }) => {
				const manager = getExtensionHostManager();
				manager.postMessageToExtension(
					input.workspaceId,
					input.viewId,
					input.message,
				);
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

				return { success: true, needsRestart: true };
			}),

		/** Set custom theme CSS for webview rendering (null = use default dark theme) */
		setThemeCss: publicProcedure
			.input(z.object({ css: z.string().nullable() }))
			.mutation(({ input }) => {
				setCustomThemeCss(input.css);
				return { success: true };
			}),

		/** Set the workspace folder path for extensions */
		setWorkspacePath: publicProcedure
			.input(
				z.object({
					workspaceId: z.string(),
					workspacePath: z.string(),
				}),
			)
			.mutation(({ input }) => {
				const manager = getExtensionHostManager();
				manager.setWorkspacePath(input.workspaceId, input.workspacePath);
				return { success: true };
			}),

		/** Notify main process of active file change (for activeTextEditor) */
		setActiveEditor: publicProcedure
			.input(
				z.object({
					workspaceId: z.string(),
					filePath: z.string().nullable(),
					languageId: z.string().optional(),
				}),
			)
			.mutation(({ input }) => {
				const manager = getExtensionHostManager();
				manager.setActiveEditor(
					input.workspaceId,
					input.filePath,
					input.languageId,
				);
				return { success: true };
			}),

		/** Download and install an extension from the VS Code Marketplace */
		installExtension: publicProcedure
			.input(z.object({ extensionId: z.string() }))
			.mutation(async ({ input }) => {
				await downloadAndInstallExtension(input.extensionId);
				return { success: true };
			}),

		/** Restart a specific extension (stops and restarts the workspace worker) */
		restartExtension: publicProcedure
			.input(
				z.object({
					extensionId: z.string(),
					workspaceId: z.string().optional(),
				}),
			)
			.mutation(async ({ input }) => {
				if (!input.workspaceId) {
					const manager = getExtensionHostManager();
					const runningWorkspaceIds = manager.getRunningWorkspaceIds();
					if (runningWorkspaceIds.length === 0) {
						return { success: false };
					}

					await Promise.all(
						runningWorkspaceIds.map(async (workspaceId) => {
							const workspacePath = manager.getWorkspacePath(workspaceId) ?? "";
							manager.stop(workspaceId);
							await manager.start(workspaceId, workspacePath);
						}),
					);
					return { success: true };
				}
				const manager = getExtensionHostManager();
				if (!manager.isRunning(input.workspaceId)) {
					return { success: false };
				}
				// Stop then explicitly restart (stop sets "stopped" status which prevents auto-restart)
				const workspacePath = manager.getWorkspacePath(input.workspaceId) ?? "";
				manager.stop(input.workspaceId);
				await manager.start(input.workspaceId, workspacePath);
				return { success: true };
			}),

		/** Subscribe to file open requests from extensions (showTextDocument) */
		subscribeOpenFile: publicProcedure
			.input(z.object({ workspaceId: z.string().optional() }).optional())
			.subscription(({ input }) => {
				return observable<{ filePath: string; line?: number }>((emit) => {
					const manager = getExtensionHostManager();
					const handler = (
						wsId: string,
						data: { filePath: string; line?: number },
					) => {
						if (input?.workspaceId && wsId !== input.workspaceId) return;
						emit.next(data);
					};
					manager.on("open-file", handler);
					return () => {
						manager.off("open-file", handler);
					};
				});
			}),

		/** Subscribe to diff open requests from extensions (vscode.diff calls) */
		subscribeDiff: publicProcedure
			.input(z.object({ workspaceId: z.string().optional() }).optional())
			.subscription(({ input }) => {
				return observable<{
					leftUri: string;
					rightUri: string;
					title?: string;
				}>((emit) => {
					const manager = getExtensionHostManager();
					const handler = (
						wsId: string,
						data: { leftUri: string; rightUri: string; title?: string },
					) => {
						if (input?.workspaceId && wsId !== input.workspaceId) return;
						emit.next(data);
					};
					manager.on("open-diff", handler);
					return () => {
						manager.off("open-diff", handler);
					};
				});
			}),

		/** Subscribe to webview events (HTML changes, messages from extension) */
		subscribeWebview: publicProcedure
			.input(z.object({ workspaceId: z.string().optional() }).optional())
			.subscription(({ input }) => {
				return observable<WebviewBridgeEvent>((emit) => {
					const manager = getExtensionHostManager();
					const handler = (wsId: string, event: WebviewBridgeEvent) => {
						if (input?.workspaceId && wsId !== input.workspaceId) return;
						emit.next(event);
					};
					manager.on("webview-event", handler);
					return () => {
						manager.off("webview-event", handler);
					};
				});
			}),
	});
};
