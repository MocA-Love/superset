import { EventEmitter } from "node:events";
import { app, net } from "electron";
import {
	createUnknownSnapshot,
	indicatorToLevel,
	type ServiceStatusDefinition,
	type ServiceStatusId,
	type ServiceStatusSnapshot,
	type StatuspageIndicator,
} from "shared/service-status-types";
import {
	type CreateServiceStatusDefinitionInput,
	createServiceStatusDefinition,
	deleteServiceStatusDefinition,
	getServiceStatusDefinition,
	listServiceStatusDefinitions,
	seedDefaultDefinitionsIfNeeded,
	type UpdateServiceStatusDefinitionInput,
	updateServiceStatusDefinition,
} from "./definitions-store";
import {
	deleteCustomIconFile,
	type SaveCustomIconFromDataUrlResult,
	saveCustomIconFromDataUrl,
} from "./icon-storage";

const POLL_INTERVAL_MS = 5 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 10_000;
// Focus-driven refresh is debounced: if the last successful refresh attempt
// was within this window we skip rather than hammering the API on every
// window/tab switch.
const FOCUS_REFRESH_MIN_INTERVAL_MS = 30_000;

type StatuspageResponse = {
	status?: { indicator?: StatuspageIndicator; description?: string };
};

export interface DefinitionsChangedEvent {
	type: "definitions";
	definitions: ServiceStatusDefinition[];
}

class ServiceStatusService extends EventEmitter {
	private definitions: ServiceStatusDefinition[] = [];
	private snapshots = new Map<ServiceStatusId, ServiceStatusSnapshot>();
	private pollTimer: ReturnType<typeof setInterval> | null = null;
	private started = false;
	private lastRefreshAt = 0;
	// Re-entry guard: ensures start()'s initial refresh and a concurrent
	// focus-driven refresh share a single fetch round instead of racing.
	private inflightRefresh: Promise<void> | null = null;

	constructor() {
		super();
		// Multiple renderers (main window + any tearoff) can each subscribe to
		// the emitter via tRPC; bump the default cap so dev HMR and StrictMode
		// remounts don't trip the listener-warning heuristic.
		this.setMaxListeners(40);
	}

	start(): void {
		if (this.started) return;
		this.started = true;
		seedDefaultDefinitionsIfNeeded();
		this.loadDefinitions();
		void this.refreshAll();
		this.pollTimer = setInterval(() => {
			void this.refreshAll();
		}, POLL_INTERVAL_MS);
		// Don't keep the event loop alive just for status polling.
		this.pollTimer.unref();
	}

	stop(): void {
		if (this.pollTimer) clearInterval(this.pollTimer);
		this.pollTimer = null;
		this.started = false;
	}

	/**
	 * Reload the definition list from the DB and prune any snapshots whose
	 * row was deleted. Initializes missing snapshots so the subscription
	 * immediately emits placeholder "確認中…" entries for new rows.
	 */
	private loadDefinitions(): void {
		this.definitions = listServiceStatusDefinitions();
		const knownIds = new Set(this.definitions.map((d) => d.id));
		for (const existingId of this.snapshots.keys()) {
			if (!knownIds.has(existingId)) {
				this.snapshots.delete(existingId);
			}
		}
		for (const def of this.definitions) {
			if (!this.snapshots.has(def.id)) {
				this.snapshots.set(def.id, createUnknownSnapshot(def));
			} else {
				// Definition edits (e.g. relabel, icon change) need to reach the
				// renderer even without a fresh poll; patch the existing
				// snapshot's definition fields and re-emit.
				const prev = this.snapshots.get(def.id);
				if (prev) {
					const merged: ServiceStatusSnapshot = {
						...prev,
						label: def.label,
						statusUrl: def.statusUrl,
						iconType: def.iconType,
						iconValue: def.iconValue,
						sortOrder: def.sortOrder,
					};
					this.snapshots.set(def.id, merged);
				}
			}
		}
	}

	getDefinitions(): ServiceStatusDefinition[] {
		return [...this.definitions];
	}

	getAll(): ServiceStatusSnapshot[] {
		return this.definitions.map(
			(def) => this.snapshots.get(def.id) ?? createUnknownSnapshot(def),
		);
	}

	// --- Definition CRUD --------------------------------------------------

	async createDefinition(
		input: CreateServiceStatusDefinitionInput,
	): Promise<ServiceStatusDefinition> {
		const created = createServiceStatusDefinition(input);
		this.loadDefinitions();
		this.emitDefinitionsChanged();
		// Emit the placeholder snapshot so the renderer immediately shows the
		// new indicator, then kick a fetch for just this row.
		const placeholder = createUnknownSnapshot(created);
		this.snapshots.set(created.id, placeholder);
		this.emit("change", placeholder);
		void this.refreshOne(created);
		return created;
	}

	async updateDefinition(
		id: string,
		patch: UpdateServiceStatusDefinitionInput,
		options?: { deleteReplacedIconPath?: string | null },
	): Promise<ServiceStatusDefinition | null> {
		const updated = updateServiceStatusDefinition(id, patch);
		if (!updated) return null;
		if (options?.deleteReplacedIconPath) {
			deleteCustomIconFile(options.deleteReplacedIconPath);
		}
		this.loadDefinitions();
		this.emitDefinitionsChanged();
		// Push the merged snapshot (done inside loadDefinitions) so the
		// renderer picks up the new label / icon without waiting for the
		// next poll.
		const snap = this.snapshots.get(id);
		if (snap) this.emit("change", snap);
		// Re-fetch if either URL changed so the snapshot reflects the new
		// target immediately instead of showing stale data until the next
		// 5-minute poll.
		if (patch.apiUrl || patch.statusUrl) {
			void this.refreshOne(updated);
		}
		return updated;
	}

	async deleteDefinition(id: string): Promise<boolean> {
		const existing = getServiceStatusDefinition(id);
		if (!existing) return false;
		const removed = deleteServiceStatusDefinition(id);
		if (!removed) return false;
		if (existing.iconType === "custom-file" && existing.iconValue) {
			deleteCustomIconFile(existing.iconValue);
		}
		this.snapshots.delete(id);
		this.loadDefinitions();
		this.emitDefinitionsChanged();
		this.emit("remove", id);
		return true;
	}

	async saveCustomIcon(
		dataUrl: string,
	): Promise<SaveCustomIconFromDataUrlResult> {
		return saveCustomIconFromDataUrl(dataUrl);
	}

	/**
	 * Delete an uncommitted custom-file icon that was uploaded by the Add /
	 * Edit dialog but never attached to a definition (user cancelled, or
	 * replaced the file before saving). `deleteCustomIconFile` already
	 * enforces the managed-directory boundary so a stray path from the
	 * renderer can't remove arbitrary files.
	 */
	deleteUncommittedIcon(absolutePath: string): void {
		deleteCustomIconFile(absolutePath);
	}

	// --- Polling ----------------------------------------------------------

	/**
	 * Refresh only when the last refresh is older than the given threshold.
	 * Used for focus-driven refreshes so rapid window switches don't produce
	 * a fetch storm.
	 */
	refreshIfStale(thresholdMs = FOCUS_REFRESH_MIN_INTERVAL_MS): void {
		if (Date.now() - this.lastRefreshAt < thresholdMs) return;
		void this.refreshAll();
	}

	refreshAll(): Promise<void> {
		// Collapse concurrent callers onto the same fetch round. The initial
		// start() refresh is async and can overlap with a focus-driven
		// refreshIfStale() that passes the 30-second check because
		// lastRefreshAt is still 0 — without this guard we'd fire the full
		// fetch twice on every cold start.
		if (this.inflightRefresh) return this.inflightRefresh;
		this.inflightRefresh = this.doRefreshAll().finally(() => {
			this.inflightRefresh = null;
		});
		return this.inflightRefresh;
	}

	private async doRefreshAll(): Promise<void> {
		// Skip fetching when offline, but still push an "offline" snapshot so
		// the UI doesn't keep rendering a stale green dot from the last
		// successful poll.
		if (!net.isOnline()) {
			this.markAllOffline();
			return;
		}
		const results = await Promise.all(
			this.definitions.map((def) => this.refreshOne(def)),
		);
		// Only record a "successful refresh" when at least one fetch actually
		// worked, so a transient failure doesn't lock the 30-second debounce
		// window in refreshIfStale() and prevent a quick recovery.
		if (results.some(Boolean)) {
			this.lastRefreshAt = Date.now();
		}
	}

	private async refreshOne(def: ServiceStatusDefinition): Promise<boolean> {
		try {
			const json = await this.fetchJson(def.apiUrl);
			const indicator = json.status?.indicator ?? null;
			const description =
				json.status?.description ||
				(indicator === "none" ? "全システム正常" : "ステータス不明");
			this.updateSnapshot({
				id: def.id,
				label: def.label,
				statusUrl: def.statusUrl,
				iconType: def.iconType,
				iconValue: def.iconValue,
				sortOrder: def.sortOrder,
				level: indicatorToLevel(indicator),
				indicator,
				description,
				checkedAt: Date.now(),
				fetchError: null,
			});
			return true;
		} catch (error) {
			const message =
				error instanceof Error ? error.message : String(error ?? "unknown");
			this.updateSnapshot({
				id: def.id,
				label: def.label,
				statusUrl: def.statusUrl,
				iconType: def.iconType,
				iconValue: def.iconValue,
				sortOrder: def.sortOrder,
				level: "unknown",
				indicator: null,
				description: "ステータスを取得できませんでした",
				checkedAt: Date.now(),
				fetchError: message,
			});
			return false;
		}
	}

	private markAllOffline(): void {
		for (const def of this.definitions) {
			this.updateSnapshot({
				id: def.id,
				label: def.label,
				statusUrl: def.statusUrl,
				iconType: def.iconType,
				iconValue: def.iconValue,
				sortOrder: def.sortOrder,
				level: "unknown",
				indicator: null,
				description: "Offline",
				checkedAt: Date.now(),
				fetchError: null,
			});
		}
	}

	private updateSnapshot(next: ServiceStatusSnapshot): void {
		this.snapshots.set(next.id, next);
		// Always emit so renderers receive the latest checkedAt.
		this.emit("change", next);
	}

	private emitDefinitionsChanged(): void {
		const event: DefinitionsChangedEvent = {
			type: "definitions",
			definitions: this.getDefinitions(),
		};
		this.emit("definitions", event);
	}

	/**
	 * Probe a candidate apiUrl and report whether it looks like a Statuspage.io
	 * v2 `/api/v2/status.json` response. Used by the "Add service" dialog to
	 * fail fast before persisting a bad row.
	 */
	async validateApiUrl(
		apiUrl: string,
	): Promise<
		| { ok: true; indicator: StatuspageIndicator; description: string }
		| { ok: false; error: string }
	> {
		try {
			const json = await this.fetchJson(apiUrl);
			if (!json.status) {
				return {
					ok: false,
					error: "レスポンスに status フィールドがありません",
				};
			}
			return {
				ok: true,
				indicator: json.status.indicator ?? "none",
				description: json.status.description ?? "",
			};
		} catch (error) {
			const message =
				error instanceof Error ? error.message : String(error ?? "unknown");
			return { ok: false, error: message };
		}
	}

	/**
	 * Proxy favicon bytes through the main process so the renderer can
	 * display them without running into CSP / CORS for arbitrary remote
	 * hosts. Returns a data URL, or null if the upstream didn't serve an
	 * image.
	 */
	async fetchFaviconDataUrl(statusUrl: string): Promise<string | null> {
		let host: string;
		try {
			host = new URL(statusUrl).host;
		} catch {
			return null;
		}
		if (!host) return null;
		// Google's S2 favicon service is resilient across hosts and returns
		// a crisp 64px icon. If it 404s we fall back to the site's /favicon.ico.
		const candidates = [
			`https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=64`,
			`https://${host}/favicon.ico`,
		];
		for (const url of candidates) {
			const dataUrl = await this.tryFetchAsDataUrl(url);
			if (dataUrl) return dataUrl;
		}
		return null;
	}

	private tryFetchAsDataUrl(url: string): Promise<string | null> {
		return new Promise((resolve) => {
			const request = net.request({ method: "GET", url, redirect: "follow" });
			let timedOut = false;
			const timeout = setTimeout(() => {
				timedOut = true;
				request.abort();
				resolve(null);
			}, REQUEST_TIMEOUT_MS);
			request.on("response", (response) => {
				if (response.statusCode < 200 || response.statusCode >= 300) {
					clearTimeout(timeout);
					resolve(null);
					return;
				}
				const mimeHeader = response.headers["content-type"];
				const mime = Array.isArray(mimeHeader)
					? mimeHeader[0]
					: (mimeHeader ?? "");
				if (!mime || !String(mime).startsWith("image/")) {
					clearTimeout(timeout);
					resolve(null);
					return;
				}
				const chunks: Buffer[] = [];
				response.on("data", (chunk: Buffer) => chunks.push(chunk));
				response.on("end", () => {
					clearTimeout(timeout);
					if (timedOut) return;
					const buf = Buffer.concat(chunks);
					if (buf.byteLength === 0) {
						resolve(null);
						return;
					}
					resolve(
						`data:${String(mime).split(";")[0]};base64,${buf.toString("base64")}`,
					);
				});
				response.on("error", () => {
					clearTimeout(timeout);
					if (timedOut) return;
					resolve(null);
				});
			});
			request.on("error", () => {
				clearTimeout(timeout);
				if (timedOut) return;
				resolve(null);
			});
			request.end();
		});
	}

	// Use Electron's net module so fetch uses Chromium's network stack and
	// bypasses renderer-side CORS / proxy quirks.
	private fetchJson(url: string): Promise<StatuspageResponse> {
		return new Promise((resolve, reject) => {
			const request = net.request({
				method: "GET",
				url,
				redirect: "follow",
			});
			let timedOut = false;
			const timeout = setTimeout(() => {
				timedOut = true;
				request.abort();
				reject(new Error(`Request timed out after ${REQUEST_TIMEOUT_MS}ms`));
			}, REQUEST_TIMEOUT_MS);

			request.on("response", (response) => {
				const chunks: Buffer[] = [];
				response.on("data", (chunk: Buffer) => {
					chunks.push(chunk);
				});
				response.on("end", () => {
					clearTimeout(timeout);
					if (timedOut) return;
					if (response.statusCode < 200 || response.statusCode >= 300) {
						reject(new Error(`HTTP ${response.statusCode}`));
						return;
					}
					try {
						const body = Buffer.concat(chunks).toString("utf-8");
						resolve(JSON.parse(body) as StatuspageResponse);
					} catch (parseError) {
						reject(parseError);
					}
				});
				response.on("error", (err: Error) => {
					clearTimeout(timeout);
					if (timedOut) return;
					reject(err);
				});
			});
			request.on("error", (err) => {
				clearTimeout(timeout);
				if (timedOut) return;
				reject(err);
			});
			request.end();
		});
	}
}

export const serviceStatusService = new ServiceStatusService();

let pollingWired = false;

export function setupServiceStatusPolling(): void {
	// Guard against duplicate wiring on HMR / re-init — the inner `start()`
	// is already idempotent via its `started` flag, but `app.on(...)` would
	// otherwise accumulate focus listeners across reloads.
	if (pollingWired) return;
	pollingWired = true;
	serviceStatusService.start();
	const onFocus = () => {
		// Debounced refresh — protects the poller from rapid window switches.
		serviceStatusService.refreshIfStale();
	};
	app.on("browser-window-focus", onFocus);
	app.on("before-quit", () => {
		app.off("browser-window-focus", onFocus);
		serviceStatusService.stop();
	});
}
