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
import { fetchStatusPayload } from "./parsers";
import { fetchStatuspageV2 } from "./parsers/statuspage-v2";
import { parseSafeHttpUrl } from "./url-safety";

const POLL_INTERVAL_MS = 5 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 10_000;
// Focus-driven refresh is debounced: if the last successful refresh attempt
// was within this window we skip rather than hammering the API on every
// window/tab switch.
const FOCUS_REFRESH_MIN_INTERVAL_MS = 30_000;

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
		// Re-fetch when any of the fields that actually influence the poll
		// result change (URL / URL / format) so the snapshot reflects the new
		// target immediately instead of showing stale data until the next
		// 5-minute poll. Label / icon edits don't need a refetch because
		// they're picked up by `loadDefinitions()` above.
		if (patch.apiUrl || patch.statusUrl || patch.format) {
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
			const { indicator, description } = await fetchStatusPayload(
				def.format,
				def.apiUrl,
			);
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
	 * fail fast before persisting a bad row. Only Statuspage-v2 is validated
	 * here because it's the only format that exposes a canonical health
	 * summary at a single URL — the AWS/GCP/Azure adapters treat missing
	 * incidents as operational regardless of response shape, so a dry-run
	 * would be misleading.
	 */
	async validateApiUrl(
		apiUrl: string,
	): Promise<
		| { ok: true; indicator: StatuspageIndicator; description: string }
		| { ok: false; error: string }
	> {
		try {
			const result = await fetchStatuspageV2(apiUrl);
			if (!result.indicator && !result.description) {
				return {
					ok: false,
					error: "レスポンスに status フィールドがありません",
				};
			}
			return {
				ok: true,
				indicator: result.indicator ?? "none",
				description: result.description,
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

	/**
	 * Manual-redirect fetcher that re-validates every Location hop against
	 * `parseSafeHttpUrl`. The previous `redirect: "follow"` form let a
	 * trusted public favicon service 30x-redirect us to a private / loopback
	 * endpoint after the outer URL had already passed input validation.
	 */
	private tryFetchAsDataUrl(url: string): Promise<string | null> {
		return new Promise((resolve) => {
			let resolvedOnce = false;
			const finish = (value: string | null): void => {
				if (resolvedOnce) return;
				resolvedOnce = true;
				resolve(value);
			};
			const doHop = (currentUrl: string, hopsLeft: number): void => {
				if (!parseSafeHttpUrl(currentUrl)) {
					finish(null);
					return;
				}
				const request = net.request({
					method: "GET",
					url: currentUrl,
					redirect: "manual",
				});
				const timer = setTimeout(() => {
					request.abort();
					finish(null);
				}, REQUEST_TIMEOUT_MS);
				request.on("response", (response) => {
					const statusCode = response.statusCode;
					if (statusCode >= 300 && statusCode < 400) {
						const raw = response.headers.location ?? response.headers.Location;
						const locationValue = Array.isArray(raw) ? raw[0] : raw;
						clearTimeout(timer);
						if (!locationValue || hopsLeft <= 0) {
							finish(null);
							return;
						}
						let nextUrl: string;
						try {
							nextUrl = new URL(locationValue, currentUrl).toString();
						} catch {
							finish(null);
							return;
						}
						doHop(nextUrl, hopsLeft - 1);
						return;
					}
					if (statusCode < 200 || statusCode >= 300) {
						clearTimeout(timer);
						finish(null);
						return;
					}
					const mimeHeader = response.headers["content-type"];
					const mime = Array.isArray(mimeHeader)
						? mimeHeader[0]
						: (mimeHeader ?? "");
					if (!mime || !String(mime).startsWith("image/")) {
						clearTimeout(timer);
						finish(null);
						return;
					}
					const chunks: Buffer[] = [];
					response.on("data", (chunk: Buffer) => chunks.push(chunk));
					response.on("end", () => {
						clearTimeout(timer);
						const buf = Buffer.concat(chunks);
						if (buf.byteLength === 0) {
							finish(null);
							return;
						}
						finish(
							`data:${String(mime).split(";")[0]};base64,${buf.toString("base64")}`,
						);
					});
					response.on("error", () => {
						clearTimeout(timer);
						finish(null);
					});
				});
				request.on("error", () => {
					clearTimeout(timer);
					finish(null);
				});
				request.end();
			};
			doHop(url, 5);
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
