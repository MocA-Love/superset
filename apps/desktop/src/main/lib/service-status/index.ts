import { EventEmitter } from "node:events";
import { app, net } from "electron";
import {
	createUnknownSnapshot,
	indicatorToLevel,
	SERVICE_STATUS_DEFINITIONS,
	type ServiceStatusDefinition,
	type ServiceStatusId,
	type ServiceStatusSnapshot,
	type StatuspageIndicator,
} from "shared/service-status-types";

const POLL_INTERVAL_MS = 5 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 10_000;
// Focus-driven refresh is debounced: if the last successful refresh attempt
// was within this window we skip rather than hammering the API on every
// window/tab switch.
const FOCUS_REFRESH_MIN_INTERVAL_MS = 30_000;

type StatuspageResponse = {
	status?: { indicator?: StatuspageIndicator; description?: string };
};

class ServiceStatusService extends EventEmitter {
	private snapshots = new Map<ServiceStatusId, ServiceStatusSnapshot>();
	private pollTimer: ReturnType<typeof setInterval> | null = null;
	private started = false;
	private lastRefreshAt = 0;

	constructor() {
		super();
		// Multiple renderers (main window + any tearoff) can each subscribe to
		// the emitter via tRPC; bump the default cap so dev HMR and StrictMode
		// remounts don't trip the listener-warning heuristic.
		this.setMaxListeners(20);
		for (const def of SERVICE_STATUS_DEFINITIONS) {
			this.snapshots.set(def.id, createUnknownSnapshot(def));
		}
	}

	start(): void {
		if (this.started) return;
		this.started = true;
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

	getAll(): ServiceStatusSnapshot[] {
		return SERVICE_STATUS_DEFINITIONS.map(
			(def) => this.snapshots.get(def.id) ?? createUnknownSnapshot(def),
		);
	}

	/**
	 * Refresh only when the last refresh is older than the given threshold.
	 * Used for focus-driven refreshes so rapid window switches don't produce
	 * a fetch storm.
	 */
	refreshIfStale(thresholdMs = FOCUS_REFRESH_MIN_INTERVAL_MS): void {
		if (Date.now() - this.lastRefreshAt < thresholdMs) return;
		void this.refreshAll();
	}

	async refreshAll(): Promise<void> {
		// Skip fetching when offline, but still push an "offline" snapshot so
		// the UI doesn't keep rendering a stale green dot from the last
		// successful poll. net.isOnline() reflects Chromium's connectivity
		// state — accurate enough to avoid guaranteed-failure polls on
		// planes / disconnected laptops while still running when the OS is
		// on a captive-portal / proxy.
		if (!net.isOnline()) {
			this.markAllOffline();
			return;
		}
		const results = await Promise.all(
			SERVICE_STATUS_DEFINITIONS.map((def) => this.refreshOne(def)),
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
		for (const def of SERVICE_STATUS_DEFINITIONS) {
			this.updateSnapshot({
				id: def.id,
				label: def.label,
				statusUrl: def.statusUrl,
				level: "unknown",
				indicator: null,
				description: "オフラインのため取得できません",
				checkedAt: Date.now(),
				fetchError: "offline",
			});
		}
	}

	private updateSnapshot(next: ServiceStatusSnapshot): void {
		const prev = this.snapshots.get(next.id);
		this.snapshots.set(next.id, next);
		// Only emit when user-visible state actually changes. checkedAt isn't
		// directly rendered — the tooltip uses a relative formatter on
		// Date.now() so it auto-refreshes whenever the Tooltip remounts.
		if (
			!prev ||
			prev.level !== next.level ||
			prev.indicator !== next.indicator ||
			prev.description !== next.description ||
			Boolean(prev.fetchError) !== Boolean(next.fetchError)
		) {
			this.emit("change", next);
		}
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
