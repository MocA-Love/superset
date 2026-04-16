import { EventEmitter } from "node:events";
import { app, net } from "electron";
import {
	indicatorToLevel,
	SERVICE_STATUS_DEFINITIONS,
	type ServiceStatusDefinition,
	type ServiceStatusSnapshot,
	type StatuspageIndicator,
} from "shared/service-status-types";

const POLL_INTERVAL_MS = 5 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 10_000;

type StatuspageResponse = {
	status?: { indicator?: StatuspageIndicator; description?: string };
};

class ServiceStatusService extends EventEmitter {
	private snapshots = new Map<string, ServiceStatusSnapshot>();
	private pollTimer: ReturnType<typeof setInterval> | null = null;
	private started = false;

	constructor() {
		super();
		for (const def of SERVICE_STATUS_DEFINITIONS) {
			this.snapshots.set(def.id, {
				id: def.id,
				label: def.label,
				statusUrl: def.statusUrl,
				level: "unknown",
				indicator: null,
				description: "Checking…",
				checkedAt: 0,
				fetchError: null,
			});
		}
	}

	start(): void {
		if (this.started) return;
		this.started = true;
		void this.refreshAll();
		this.pollTimer = setInterval(() => {
			void this.refreshAll();
		}, POLL_INTERVAL_MS);
	}

	stop(): void {
		if (this.pollTimer) clearInterval(this.pollTimer);
		this.pollTimer = null;
		this.started = false;
	}

	getAll(): ServiceStatusSnapshot[] {
		return SERVICE_STATUS_DEFINITIONS.map(
			(def) => this.snapshots.get(def.id) ?? this.unknownFor(def),
		);
	}

	refreshAll(): Promise<void> {
		return Promise.all(
			SERVICE_STATUS_DEFINITIONS.map((def) => this.refreshOne(def)),
		).then(() => undefined);
	}

	private async refreshOne(def: ServiceStatusDefinition): Promise<void> {
		try {
			const json = await this.fetchJson(def.apiUrl);
			const indicator = json.status?.indicator ?? null;
			const description =
				json.status?.description ||
				(indicator === "none"
					? "All Systems Operational"
					: "Status unavailable");
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
		}
	}

	private updateSnapshot(next: ServiceStatusSnapshot): void {
		this.snapshots.set(next.id, next);
		// Emit on every poll so the renderer's "last checked" timestamp stays
		// fresh — the initial getAll query is cached with staleTime: Infinity,
		// so without an emit here the tooltip would freeze on the first value.
		this.emit("change", next);
	}

	private unknownFor(def: ServiceStatusDefinition): ServiceStatusSnapshot {
		return {
			id: def.id,
			label: def.label,
			statusUrl: def.statusUrl,
			level: "unknown",
			indicator: null,
			description: "Checking…",
			checkedAt: 0,
			fetchError: null,
		};
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

export function setupServiceStatusPolling(): void {
	serviceStatusService.start();
	app.on("browser-window-focus", () => {
		// Refresh on focus so users returning to the app see fresh state
		// without waiting for the 5-minute interval.
		void serviceStatusService.refreshAll();
	});
	app.on("before-quit", () => {
		serviceStatusService.stop();
	});
}
