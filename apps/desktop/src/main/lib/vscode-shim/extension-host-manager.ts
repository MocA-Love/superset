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
import { clearWebviewHtml } from "./api/webview-server";
import type { MainToWorkerMessage, WorkerToMainMessage } from "./ipc-types";

const BASE_RESTART_DELAY = 1000;
const MAX_RESTART_DELAY = 30000;
const MAX_RESTART_ATTEMPTS = 5;
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
	private startPromises = new Map<string, Promise<void>>();
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
		const existing = this.instances.get(workspaceId);
		if (
			existing &&
			(existing.status === "running" || existing.status === "starting")
		) {
			existing.workspacePath = workspacePath;
			this.sendToWorker(workspaceId, {
				type: "set-workspace-path",
				workspacePath,
			});
			const inFlightStart = this.startPromises.get(workspaceId);
			if (inFlightStart) {
				return inFlightStart;
			}
			if (existing.status === "running" && existing.process) {
				return;
			}
		}

		const inFlightStart = this.startPromises.get(workspaceId);
		if (inFlightStart) {
			return inFlightStart;
		}

		const startPromise = this.spawn(workspaceId, workspacePath).finally(() => {
			if (this.startPromises.get(workspaceId) === startPromise) {
				this.startPromises.delete(workspaceId);
			}
		});
		this.startPromises.set(workspaceId, startPromise);
		await startPromise;
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
		const onStdout = (data: Buffer) => {
			for (const line of data.toString().split("\n").filter(Boolean)) {
				console.log(line);
			}
		};
		const onStderr = (data: Buffer) => {
			for (const line of data.toString().split("\n").filter(Boolean)) {
				console.error(line);
			}
		};
		child.stdout?.on("data", onStdout);
		child.stderr?.on("data", onStderr);

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

			// Release stdout/stderr listeners to prevent accumulation
			child.stdout?.off("data", onStdout);
			child.stderr?.off("data", onStderr);

			// Clean up viewId mappings and htmlStore for this workspace
			this.clearTrackedWebviewsForWorkspace(workspaceId);

			// Schedule restart if not intentionally stopped
			if (!wasStopped) {
				this.scheduleRestart(workspaceId);
			}
		});

		// Wait for ready message
		await new Promise<void>((resolve, reject) => {
			let settled = false;

			const timer = setTimeout(() => {
				if (settled) return;
				settled = true;
				child.off("message", onMessage);
				reject(
					new Error(
						`Extension host worker ${workspaceId} failed to become ready within ${READY_TIMEOUT}ms`,
					),
				);
			}, READY_TIMEOUT);

			const onMessage = (msg: WorkerToMainMessage) => {
				if (msg.type === "ready") {
					if (settled) return;
					settled = true;
					clearTimeout(timer);
					child.off("message", onMessage);
					instance.status = "running";
					instance.restartCount = 0;
					resolve();
				}
			};
			child.on("message", onMessage);

			child.on("error", (err) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				child.off("message", onMessage);
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

			case "open-diff":
				this.emit("open-diff", workspaceId, msg);
				break;

			case "show-dialog":
				// Proxy dialog calls to Electron main process and return result
				this.handleDialogRequest(workspaceId, msg);
				break;

			case "show-quickpick":
				this.handleQuickPickRequest(workspaceId, msg);
				break;

			case "show-open-dialog":
				this.handleOpenDialogRequest(workspaceId, msg);
				break;
		}
	}

	private async handleDialogRequest(
		workspaceId: string,
		msg: Extract<WorkerToMainMessage, { type: "show-dialog" }>,
	): Promise<void> {
		try {
			const { dialog } = require("electron");
			const result = await dialog.showMessageBox({
				type:
					msg.method === "showErrorMessage"
						? "error"
						: msg.method === "showWarningMessage"
							? "warning"
							: "info",
				message: msg.message,
				buttons: msg.items,
			});
			this.sendToWorker(workspaceId, {
				type: "dialog-result",
				requestId: msg.requestId,
				selectedIndex: result.response,
			});
		} catch {
			this.sendToWorker(workspaceId, {
				type: "dialog-result",
				requestId: msg.requestId,
				selectedIndex: -1,
			});
		}
	}

	private async handleQuickPickRequest(
		workspaceId: string,
		msg: Extract<WorkerToMainMessage, { type: "show-quickpick" }>,
	): Promise<void> {
		try {
			const { dialog } = require("electron");
			const result = await dialog.showMessageBox({
				type: "question",
				title: msg.placeHolder ?? "Select",
				message: msg.placeHolder ?? "Select an option",
				buttons: [...msg.labels, "Cancel"],
				cancelId: msg.labels.length,
			});
			const selectedIndex =
				result.response === msg.labels.length ? -1 : result.response;
			this.sendToWorker(workspaceId, {
				type: "dialog-result",
				requestId: msg.requestId,
				selectedIndex,
			});
		} catch {
			this.sendToWorker(workspaceId, {
				type: "dialog-result",
				requestId: msg.requestId,
				selectedIndex: -1,
			});
		}
	}

	private async handleOpenDialogRequest(
		workspaceId: string,
		msg: Extract<WorkerToMainMessage, { type: "show-open-dialog" }>,
	): Promise<void> {
		try {
			const { dialog } = require("electron");
			const properties: Array<
				"openFile" | "openDirectory" | "multiSelections"
			> = [];
			if (msg.canSelectFolders) properties.push("openDirectory");
			if (msg.canSelectFiles !== false) properties.push("openFile");
			if (msg.canSelectMany) properties.push("multiSelections");
			const result = await dialog.showOpenDialog({
				properties,
				title: msg.title,
				filters: msg.filters,
				defaultPath: msg.defaultPath,
			});
			this.sendToWorker(workspaceId, {
				type: "open-dialog-result",
				requestId: msg.requestId,
				filePaths:
					result.canceled || result.filePaths.length === 0
						? null
						: result.filePaths,
			});
		} catch {
			this.sendToWorker(workspaceId, {
				type: "open-dialog-result",
				requestId: msg.requestId,
				filePaths: null,
			});
		}
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
		this.startPromises.delete(workspaceId);

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

	getWorkspacePath(workspaceId: string): string | undefined {
		return this.instances.get(workspaceId)?.workspacePath;
	}

	getWorkspaceForViewId(viewId: string): string | undefined {
		return this.viewIdToWorkspace.get(viewId);
	}

	getRunningWorkspaceIds(): string[] {
		return [...this.instances.entries()]
			.filter(([, instance]) => instance.status === "running")
			.map(([workspaceId]) => workspaceId);
	}

	private clearTrackedWebviewsForWorkspace(workspaceId: string): void {
		for (const [viewId, wsId] of this.viewIdToWorkspace) {
			if (wsId !== workspaceId) continue;
			this.viewIdToWorkspace.delete(viewId);
			clearWebviewHtml(viewId);
		}
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

		if (instance.restartCount >= MAX_RESTART_ATTEMPTS) {
			console.error(
				`[ext-host-manager] Max restart attempts (${MAX_RESTART_ATTEMPTS}) reached for ${workspaceId}, giving up`,
			);
			instance.status = "stopped";
			return;
		}

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
