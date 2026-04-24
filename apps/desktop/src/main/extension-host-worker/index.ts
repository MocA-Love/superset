/**
 * Extension Host Worker — Per-Workspace Subprocess Entry Point
 *
 * Spawned by ExtensionHostManager via child_process.spawn().
 * Each workspace gets its own instance of this process, providing
 * full isolation of extension state, workspace path, and webview providers.
 *
 * Run with: ELECTRON_RUN_AS_NODE=1 electron dist/main/extension-host-worker.js
 */

import os from "node:os";
import path from "node:path";
import type {
	MainToWorkerMessage,
	WorkerToMainMessage,
} from "../lib/vscode-shim/ipc-types";

// Read config from environment
const workspacePath = process.env.EXTENSION_HOST_WORKSPACE_PATH ?? "";
const workspaceId = process.env.EXTENSION_HOST_WORKSPACE_ID ?? "";
const extensionsDir =
	process.env.EXTENSION_HOST_EXTENSIONS_DIR ??
	path.join(os.homedir(), ".vscode", "extensions");

function send(msg: WorkerToMainMessage): void {
	process.send?.(msg);
}

async function main() {
	console.log(
		`[ext-host-worker:${workspaceId}] Starting with workspace: ${workspacePath}`,
	);

	// Import shim modules (each process gets its own copy)
	const { setWorkspacePath } = await import("../lib/vscode-shim/api/workspace");
	const {
		setActiveTextEditor,
		onOpenFile,
		onOpenDiff,
		setSendToMain,
		resolveDialogResult,
		resolveOpenDialogResult,
	} = await import("../lib/vscode-shim/api/window");
	setSendToMain(send);
	const { commands } = await import("../lib/vscode-shim/api/commands");
	const { discoverExtensions, loadExtension, deactivateAll } = await import(
		"../lib/vscode-shim/loader"
	);
	const { getActivePanel, getActiveView, onWebviewEvent, resolveWebviewView } =
		await import("../lib/vscode-shim/api/webview");
	const { registerExtensionDefaults } = await import(
		"../lib/vscode-shim/api/configuration"
	);

	// Read enabled config
	let enabledConfig: Record<string, boolean> = {};
	try {
		const enabledConfigPath = process.env.EXTENSION_HOST_ENABLED_CONFIG;
		if (enabledConfigPath) {
			const fs = await import("node:fs");
			if (fs.existsSync(enabledConfigPath)) {
				enabledConfig = JSON.parse(fs.readFileSync(enabledConfigPath, "utf-8"));
			}
		}
	} catch {}

	// Set workspace path
	if (workspacePath) {
		setWorkspacePath(workspacePath);
	}

	// Set platform context
	const platform =
		process.platform === "darwin"
			? "darwin"
			: process.platform === "win32"
				? "windows"
				: "linux";
	commands.executeCommand("setContext", "os", platform);

	// Listen for webview events and relay to main process
	onWebviewEvent((event) => {
		send({ type: "webview-event", event });
	});

	// Listen for file open requests
	onOpenFile((data) => {
		send({ type: "open-file", filePath: data.filePath, line: data.line });
	});

	// Listen for diff open requests
	onOpenDiff((data) => {
		send({
			type: "open-diff",
			leftUri: data.leftUri,
			rightUri: data.rightUri,
			title: data.title,
			leftContent: data.leftContent,
		});
	});

	// Supported extension IDs
	const SUPPORTED_EXTENSIONS = new Set(
		(
			process.env.EXTENSION_HOST_SUPPORTED_IDS ??
			"anthropic.claude-code,openai.chatgpt,moonshot-ai.kimi-code"
		)
			.split(",")
			.map((s) => s.trim()),
	);

	// Discover and load extensions
	const discovered = discoverExtensions(extensionsDir);
	const toLoad = discovered.filter((ext) => SUPPORTED_EXTENSIONS.has(ext.id));

	// Pick latest version for each extension
	const byId = new Map<string, (typeof toLoad)[0]>();
	for (const ext of toLoad) {
		const existing = byId.get(ext.id);
		if (!existing || ext.manifest.version > existing.manifest.version) {
			byId.set(ext.id, ext);
		}
	}

	for (const ext of byId.values()) {
		if (enabledConfig[ext.id] === false) {
			console.log(
				`[ext-host-worker:${workspaceId}] Skipping disabled: ${ext.id}`,
			);
			continue;
		}
		try {
			registerExtensionDefaults(ext.manifest);
			await loadExtension(ext);
			console.log(`[ext-host-worker:${workspaceId}] Loaded: ${ext.id}`);
		} catch (err) {
			console.error(
				`[ext-host-worker:${workspaceId}] Failed to load ${ext.id}:`,
				err,
			);
		}
	}

	// Handle IPC messages from main process
	process.on("message", async (msg: MainToWorkerMessage) => {
		switch (msg.type) {
			case "set-active-editor":
				setActiveTextEditor(msg.filePath, msg.languageId);
				break;

			case "set-workspace-path":
				setWorkspacePath(msg.workspacePath);
				break;

			case "resolve-webview": {
				const result = resolveWebviewView(msg.viewType, msg.extensionPath);
				if (result) {
					const { viewId, view } = result;
					// Get HTML (may be set synchronously or async)
					let html = (view.webview as { html?: string }).html ?? null;

					// If HTML not yet set, wait up to 5s
					if (!html) {
						html = await new Promise<string | null>((resolve) => {
							let settled = false;
							let interval: ReturnType<typeof setInterval> | null = null;
							let timeout: ReturnType<typeof setTimeout> | null = null;

							const finish = (value: string | null) => {
								if (settled) return;
								settled = true;
								if (interval !== null) {
									clearInterval(interval);
									interval = null;
								}
								if (timeout !== null) {
									clearTimeout(timeout);
									timeout = null;
								}
								resolve(value);
							};

							const checkHtml = () =>
								(view.webview as { html?: string }).html ?? null;
							const immediate = checkHtml();
							if (immediate) {
								finish(immediate);
								return;
							}
							interval = setInterval(() => {
								const h = checkHtml();
								if (h) finish(h);
							}, 200);
							timeout = setTimeout(() => {
								finish(checkHtml());
							}, 5000);
						});
					}

					send({
						type: "resolve-webview-result",
						requestId: msg.requestId,
						viewId,
						html,
					});
				} else {
					send({
						type: "resolve-webview-result",
						requestId: msg.requestId,
						viewId: null,
						html: null,
					});
				}
				break;
			}

			case "post-message": {
				const target = getActiveView(msg.viewId) ?? getActivePanel(msg.viewId);
				if (target) {
					const webview = target.webview as {
						_onDidReceiveMessage?: { fire(data: unknown): void };
					};
					webview._onDidReceiveMessage?.fire(msg.message);
				}
				break;
			}

			case "shutdown":
				await deactivateAll();
				process.exit(0);
				break;

			case "dialog-result":
				resolveDialogResult(msg.requestId, msg.selectedIndex);
				break;

			case "open-dialog-result":
				resolveOpenDialogResult(msg.requestId, msg.filePaths);
				break;
		}
	});

	// Signal ready
	send({ type: "ready" });
	console.log(`[ext-host-worker:${workspaceId}] Ready`);
}

main().catch((err) => {
	console.error(`[ext-host-worker:${workspaceId}] Fatal error:`, err);
	process.exit(1);
});

// Graceful shutdown
process.on("SIGTERM", async () => {
	try {
		const { deactivateAll } = await import("../lib/vscode-shim/loader");
		await deactivateAll();
	} catch {}
	process.exit(0);
});

// Orphan check: exit if parent dies
const parentPid = process.ppid;
const parentCheck = setInterval(() => {
	try {
		process.kill(parentPid, 0);
	} catch {
		clearInterval(parentCheck);
		console.log(
			`[ext-host-worker:${workspaceId}] Parent exited, shutting down`,
		);
		process.exit(0);
	}
}, 5000);
parentCheck.unref();
