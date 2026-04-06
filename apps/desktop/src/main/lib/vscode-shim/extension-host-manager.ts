/**
 * Extension Host Manager — manages per-workspace extension host processes.
 *
 * Each active workspace gets its own child process running extension-host-worker.js,
 * providing full isolation of extension state, workspace paths, and webview providers.
 *
 * Follows the same pattern as host-service-manager.ts for process lifecycle.
 */

import childProcess from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import os from "node:os";
import path from "node:path";
import type { MainToWorkerMessage, WorkerToMainMessage } from "./ipc-types";

const BASE_RESTART_DELAY = 1000;
const MAX_RESTART_DELAY = 30000;
const READY_TIMEOUT = 15000;

interface ExtensionHostProcess {
	workspaceId: string;
	workspacePath: string;
	process: childProcess.ChildProcess | null;
	status: "starting" | "running" | "degraded" | "stopped";
	restartCount: number;
	lastCrash?: number;
}

interface PendingResolve {
	resolve: (result: { viewId: string | null; html: string | null }) => void;
	timer: ReturnType<typeof setTimeout>;
}

export class ExtensionHostManager extends EventEmitter {
	private instances = new Map<string, ExtensionHostProcess>();
	private pendingResolves = new Map<string, PendingResolve>();
	private scheduledRestarts = new Map<string, ReturnType<typeof setTimeout>>();
	private viewIdToWorkspace = new Map<string, string>();
	private workerScriptPath: string;
	private extensionsDir: string;
	private enabledConfigPath: string;

	constructor() {
		super();
		this.workerScriptPath = path.join(__dirname, "extension-host-worker.js");
		this.extensionsDir = path.join(os.homedir(), ".vscode", "extensions");

		// Resolve enabled config path
		try {
			const { app } = require("electron");
			this.enabledConfigPath = path.join(
				app.getPath("userData"),
				"vscode-extensions-enabled.json",
			);
		} catch {
			this.enabledConfigPath = path.join(
				os.homedir(),
				".superset-desktop",
				"vscode-extensions-enabled.json",
			);
		}
	}

	async start(workspaceId: string, workspacePath: string): Promise<void> {
		// If already running, just update workspace path
		const existing = this.instances.get(workspaceId);
		if (existing?.status === "running" && existing.process) {
			this.sendToWorker(workspaceId, {
				type: "set-workspace-path",
				workspacePath,
			});
			existing.workspacePath = workspacePath;
			return;
		}

		await this.spawn(workspaceId, workspacePath);
	}

	private async spawn(
		workspaceId: string,
		workspacePath: string,
	): Promise<void> {
		const instance: ExtensionHostProcess = {
			workspaceId,
			workspacePath,
			process: null,
			status: "starting",
			restartCount: 0,
		};
		this.instances.set(workspaceId, instance);

		const env: Record<string, string> = {
			...(process.env as Record<string, string>),
			ELECTRON_RUN_AS_NODE: "1",
			EXTENSION_HOST_WORKSPACE_ID: workspaceId,
			EXTENSION_HOST_WORKSPACE_PATH: workspacePath,
			EXTENSION_HOST_EXTENSIONS_DIR: this.extensionsDir,
			EXTENSION_HOST_ENABLED_CONFIG: this.enabledConfigPath,
			NODE_ENV: process.env.NODE_ENV ?? "production",
		};

		const child = childProcess.spawn(
			process.execPath,
			[this.workerScriptPath],
			{
				stdio: ["ignore", "pipe", "pipe", "ipc"],
				env,
			},
		);

		instance.process = child;

		// Pipe stdout/stderr with workspace prefix
		child.stdout?.on("data", (data: Buffer) => {
			for (const line of data.toString().split("\n").filter(Boolean)) {
				console.log(line);
			}
		});
		child.stderr?.on("data", (data: Buffer) => {
			for (const line of data.toString().split("\n").filter(Boolean)) {
				console.error(line);
			}
		});

		// Handle IPC messages from worker
		child.on("message", (msg: WorkerToMainMessage) => {
			this.handleWorkerMessage(workspaceId, msg);
		});

		// Handle exit
		child.on("exit", (code) => {
			console.log(
				`[ext-host-manager] Worker ${workspaceId} exited with code ${code}`,
			);
			const wasStopped = instance.status === "stopped";
			instance.status = "degraded";
			instance.process = null;
			instance.lastCrash = Date.now();

			// Clean up viewId mappings
			for (const [vid, wsId] of this.viewIdToWorkspace) {
				if (wsId === workspaceId) {
					this.viewIdToWorkspace.delete(vid);
				}
			}

			// Schedule restart if not intentionally stopped
			if (!wasStopped) {
				this.scheduleRestart(workspaceId);
			}
		});

		// Wait for ready message
		await new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => {
				reject(
					new Error(
						`Extension host worker ${workspaceId} failed to become ready within ${READY_TIMEOUT}ms`,
					),
				);
			}, READY_TIMEOUT);

			const onMessage = (msg: WorkerToMainMessage) => {
				if (msg.type === "ready") {
					clearTimeout(timer);
					child.removeListener("message", onMessage);
					instance.status = "running";
					instance.restartCount = 0;
					resolve();
				}
			};
			child.on("message", onMessage);

			child.on("error", (err) => {
				clearTimeout(timer);
				reject(err);
			});
		});
	}

	private handleWorkerMessage(
		workspaceId: string,
		msg: WorkerToMainMessage,
	): void {
		switch (msg.type) {
			case "ready":
				// Handled in spawn()
				break;

			case "webview-event":
				// Track viewId → workspaceId mapping
				if (msg.event.type === "html" || msg.event.type === "panel-created") {
					this.viewIdToWorkspace.set(msg.event.viewId, workspaceId);
				}
				if (msg.event.type === "dispose") {
					this.viewIdToWorkspace.delete(msg.event.viewId);
				}
				this.emit("webview-event", workspaceId, msg.event);
				break;

			case "resolve-webview-result": {
				const pending = this.pendingResolves.get(msg.requestId);
				if (pending) {
					clearTimeout(pending.timer);
					this.pendingResolves.delete(msg.requestId);
					if (msg.viewId) {
						this.viewIdToWorkspace.set(msg.viewId, workspaceId);
					}
					pending.resolve({ viewId: msg.viewId, html: msg.html });
				}
				break;
			}

			case "open-file":
				this.emit("open-file", workspaceId, msg);
				break;

			case "show-dialog":
				// Proxy dialog calls to Electron main process
				this.handleDialogRequest(msg);
				break;
		}
	}

	private async handleDialogRequest(
		msg: Extract<WorkerToMainMessage, { type: "show-dialog" }>,
	): Promise<void> {
		try {
			const { dialog } = require("electron");
			const _result = await dialog.showMessageBox({
				type:
					msg.method === "showErrorMessage"
						? "error"
						: msg.method === "showWarningMessage"
							? "warning"
							: "info",
				message: msg.message,
				buttons: msg.items,
			});
			// Could send result back via IPC if needed
		} catch {}
	}

	async resolveWebview(
		workspaceId: string,
		viewType: string,
		extensionPath: string,
	): Promise<{ viewId: string | null; html: string | null }> {
		const instance = this.instances.get(workspaceId);
		if (!instance?.process || instance.status !== "running") {
			return { viewId: null, html: null };
		}

		const requestId = randomUUID();

		return new Promise((resolve) => {
			const timer = setTimeout(() => {
				this.pendingResolves.delete(requestId);
				resolve({ viewId: null, html: null });
			}, 10000);

			this.pendingResolves.set(requestId, { resolve, timer });

			this.sendToWorker(workspaceId, {
				type: "resolve-webview",
				requestId,
				viewType,
				extensionPath,
			});
		});
	}

	postMessageToExtension(
		workspaceId: string,
		viewId: string,
		message: unknown,
	): void {
		// Resolve workspace from viewId if not provided
		const resolvedWs = workspaceId || this.viewIdToWorkspace.get(viewId);
		if (!resolvedWs) return;

		this.sendToWorker(resolvedWs, {
			type: "post-message",
			viewId,
			message,
		});
	}

	setActiveEditor(
		workspaceId: string,
		filePath: string | null,
		languageId?: string,
	): void {
		this.sendToWorker(workspaceId, {
			type: "set-active-editor",
			filePath,
			languageId,
		});
	}

	setWorkspacePath(workspaceId: string, workspacePath: string): void {
		const instance = this.instances.get(workspaceId);
		if (instance) {
			instance.workspacePath = workspacePath;
		}
		this.sendToWorker(workspaceId, {
			type: "set-workspace-path",
			workspacePath,
		});
	}

	stop(workspaceId: string): void {
		const instance = this.instances.get(workspaceId);
		if (!instance) return;

		instance.status = "stopped";

		// Cancel scheduled restart
		const restartTimer = this.scheduledRestarts.get(workspaceId);
		if (restartTimer) {
			clearTimeout(restartTimer);
			this.scheduledRestarts.delete(workspaceId);
		}

		// Send shutdown message
		if (instance.process) {
			this.sendToWorker(workspaceId, { type: "shutdown" });
			// Force kill after 5s
			const killTimer = setTimeout(() => {
				instance.process?.kill("SIGKILL");
			}, 5000);
			instance.process.on("exit", () => clearTimeout(killTimer));
		}

		this.instances.delete(workspaceId);
	}

	stopAll(): void {
		for (const id of [...this.instances.keys()]) {
			this.stop(id);
		}
	}

	isRunning(workspaceId: string): boolean {
		const instance = this.instances.get(workspaceId);
		return instance?.status === "running";
	}

	getWorkspaceForViewId(viewId: string): string | undefined {
		return this.viewIdToWorkspace.get(viewId);
	}

	private sendToWorker(workspaceId: string, msg: MainToWorkerMessage): void {
		const instance = this.instances.get(workspaceId);
		if (instance?.process?.connected) {
			instance.process.send(msg);
		}
	}

	private scheduleRestart(workspaceId: string): void {
		const instance = this.instances.get(workspaceId);
		if (!instance || instance.status === "stopped") return;

		const delay = Math.min(
			BASE_RESTART_DELAY * 2 ** instance.restartCount,
			MAX_RESTART_DELAY,
		);
		instance.restartCount++;

		console.log(
			`[ext-host-manager] Scheduling restart for ${workspaceId} in ${delay}ms (attempt ${instance.restartCount})`,
		);

		const timer = setTimeout(() => {
			this.scheduledRestarts.delete(workspaceId);
			if (instance.status === "degraded") {
				this.spawn(workspaceId, instance.workspacePath).catch((err) => {
					console.error(
						`[ext-host-manager] Restart failed for ${workspaceId}:`,
						err,
					);
				});
			}
		}, delay);

		this.scheduledRestarts.set(workspaceId, timer);
	}
}

// Singleton
let manager: ExtensionHostManager | null = null;

export function getExtensionHostManager(): ExtensionHostManager {
	if (!manager) {
		manager = new ExtensionHostManager();
	}
	return manager;
}
