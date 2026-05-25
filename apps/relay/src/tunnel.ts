import { createApiClient } from "./api-client";
import type { TunnelHttpResponse, TunnelRequest } from "./types";

type WsSocket = {
	send: (data: string | ArrayBuffer | Uint8Array<ArrayBuffer>) => void;
	readyState: number;
	close: (code?: number, reason?: string) => void;
};

const PING_INTERVAL_MS = 30_000;
const PING_TIMEOUT_MISSED = 3;
const ONLINE_DEBOUNCE_MS = 250;
const SET_ONLINE_RETRY_BASE_MS = 500;
const SET_ONLINE_RETRY_MAX_MS = 8_000;
const SET_ONLINE_MAX_ATTEMPTS = 3;
const MAX_PENDING_REQUESTS_PER_TUNNEL = 1_000;

interface PendingRequest {
	resolve: (response: TunnelHttpResponse) => void;
	reject: (error: Error) => void;
	timer: ReturnType<typeof setTimeout>;
}

interface TunnelState {
	hostId: string;
	token: string;
	ws: WsSocket;
	pendingRequests: Map<string, PendingRequest>;
	activeChannels: Map<string, WsSocket>;
	pingTimer: ReturnType<typeof setInterval> | null;
	missedPings: number;
}

export class TunnelManager {
	static readonly WS_CLOSE_DRAIN = 4001;

	private readonly tunnels = new Map<string, TunnelState>();
	private readonly requestTimeoutMs: number;
	private readonly onlineState = new Map<string, boolean>();
	private readonly onlineDebounce = new Map<
		string,
		ReturnType<typeof setTimeout>
	>();
	private readonly onlineWriteVersions = new Map<string, number>();
	private draining = false;

	constructor(requestTimeoutMs = 30_000) {
		this.requestTimeoutMs = requestTimeoutMs;
	}

	register(hostId: string, token: string, ws: WsSocket): void {
		if (this.draining) {
			ws.close(TunnelManager.WS_CLOSE_DRAIN, "Server draining for deploy");
			return;
		}

		if (this.tunnels.has(hostId)) {
			ws.close(1000, "Tunnel already registered");
			return;
		}

		const tunnel: TunnelState = {
			hostId,
			token,
			ws,
			pendingRequests: new Map(),
			activeChannels: new Map(),
			pingTimer: null,
			missedPings: 0,
		};

		this.tunnels.set(hostId, tunnel);

		tunnel.pingTimer = setInterval(() => {
			tunnel.missedPings++;
			if (tunnel.missedPings >= PING_TIMEOUT_MISSED) {
				ws.close(1001, "Ping timeout");
				return;
			}
			this.send(ws, { type: "ping" });
		}, PING_INTERVAL_MS);

		this.scheduleOnlineWrite(hostId, token, true);
		console.log(`[relay] tunnel registered: ${hostId}`);
	}

	unregister(hostId: string): void {
		const tunnel = this.tunnels.get(hostId);
		if (!tunnel) return;

		this.disposeTunnel(tunnel, "Tunnel disconnected", 1000);
		console.log(`[relay] tunnel unregistered: ${hostId}`);
	}

	async drain(reason = "Server draining for deploy"): Promise<void> {
		this.draining = true;
		const tunnels = Array.from(this.tunnels.values());
		console.log(`[relay] draining ${tunnels.length} tunnels`);

		for (const tunnel of tunnels) {
			try {
				this.send(tunnel.ws, { type: "drain", reason });
			} catch {
				// best-effort; close below still handles the socket.
			}
		}

		await new Promise((resolve) => setTimeout(resolve, 500));

		for (const tunnel of tunnels) {
			this.disposeTunnel(tunnel, reason, TunnelManager.WS_CLOSE_DRAIN);
		}

		const WS_CLOSED = 3;
		const deadline = Date.now() + 1_500;
		while (Date.now() < deadline) {
			if (tunnels.every((tunnel) => tunnel.ws.readyState === WS_CLOSED)) break;
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
	}

	private disposeTunnel(
		tunnel: TunnelState,
		reason: string,
		tunnelCloseCode: number,
	): void {
		if (tunnel.pingTimer) clearInterval(tunnel.pingTimer);

		for (const [, pending] of tunnel.pendingRequests) {
			clearTimeout(pending.timer);
			pending.reject(new Error(reason));
		}

		for (const [, clientWs] of tunnel.activeChannels) {
			clientWs.close(1001, reason);
		}

		this.scheduleOnlineWrite(tunnel.hostId, tunnel.token, false);
		this.tunnels.delete(tunnel.hostId);

		try {
			tunnel.ws.close(tunnelCloseCode, reason);
		} catch {
			// already closed
		}
	}

	private scheduleOnlineWrite(
		hostId: string,
		token: string,
		isOnline: boolean,
	): void {
		// Debounce + drop redundant writes so flapping reconnects don't spam the API.
		if (this.onlineState.get(hostId) === isOnline) {
			const pending = this.onlineDebounce.get(hostId);
			if (pending) {
				clearTimeout(pending);
				this.onlineDebounce.delete(hostId);
			}
			this.onlineWriteVersions.set(
				hostId,
				(this.onlineWriteVersions.get(hostId) ?? 0) + 1,
			);
			return;
		}
		const pending = this.onlineDebounce.get(hostId);
		if (pending) clearTimeout(pending);
		const version = (this.onlineWriteVersions.get(hostId) ?? 0) + 1;
		this.onlineWriteVersions.set(hostId, version);
		const timer = setTimeout(() => {
			this.onlineDebounce.delete(hostId);
			void this.attemptOnlineWrite(hostId, token, isOnline, version);
		}, ONLINE_DEBOUNCE_MS);
		this.onlineDebounce.set(hostId, timer);
	}

	private async attemptOnlineWrite(
		hostId: string,
		token: string,
		isOnline: boolean,
		version: number,
	): Promise<void> {
		for (let attempt = 0; attempt < SET_ONLINE_MAX_ATTEMPTS; attempt++) {
			if (this.onlineWriteVersions.get(hostId) !== version) return;
			try {
				await createApiClient(token).host.setOnline.mutate({
					hostId,
					isOnline,
				});
				if (this.onlineWriteVersions.get(hostId) !== version) return;
				if (isOnline) {
					this.onlineState.set(hostId, true);
				} else {
					this.onlineState.delete(hostId);
				}
				if (this.onlineWriteVersions.get(hostId) === version) {
					this.onlineWriteVersions.delete(hostId);
				}
				return;
			} catch (err) {
				if (this.onlineWriteVersions.get(hostId) !== version) return;
				if (attempt === SET_ONLINE_MAX_ATTEMPTS - 1) {
					console.error(
						`[relay] setOnline(${isOnline}) failed for ${hostId} after ${SET_ONLINE_MAX_ATTEMPTS} attempts`,
						err,
					);
					this.onlineState.delete(hostId);
					if (this.onlineWriteVersions.get(hostId) === version) {
						this.onlineWriteVersions.delete(hostId);
					}
					return;
				}
				const delay = Math.min(
					SET_ONLINE_RETRY_BASE_MS * 2 ** attempt,
					SET_ONLINE_RETRY_MAX_MS,
				);
				await new Promise((resolve) => setTimeout(resolve, delay));
			}
		}
	}

	hasTunnel(hostId: string): boolean {
		return this.tunnels.has(hostId);
	}

	async sendHttpRequest(
		hostId: string,
		req: {
			method: string;
			path: string;
			headers: Record<string, string>;
			body?: string;
		},
	): Promise<TunnelHttpResponse> {
		const tunnel = this.tunnels.get(hostId);
		if (!tunnel) throw new Error("Host not connected");
		if (tunnel.pendingRequests.size >= MAX_PENDING_REQUESTS_PER_TUNNEL) {
			throw new Error("Host overloaded (pending request queue full)");
		}

		const id = crypto.randomUUID();

		return new Promise<TunnelHttpResponse>((resolve, reject) => {
			const timer = setTimeout(() => {
				tunnel.pendingRequests.delete(id);
				reject(new Error("Request timed out"));
			}, this.requestTimeoutMs);

			tunnel.pendingRequests.set(id, { resolve, reject, timer });
			this.send(tunnel.ws, {
				type: "http",
				id,
				method: req.method,
				path: req.path,
				headers: req.headers,
				body: req.body,
			});
		});
	}

	openWsChannel(
		hostId: string,
		path: string,
		query: string | undefined,
		clientWs: WsSocket,
	): string {
		const tunnel = this.tunnels.get(hostId);
		if (!tunnel) throw new Error("Host not connected");

		const id = crypto.randomUUID();
		tunnel.activeChannels.set(id, clientWs);
		this.send(tunnel.ws, { type: "ws:open", id, path, query });
		return id;
	}

	sendWsFrame(hostId: string, channelId: string, data: string): void {
		const tunnel = this.tunnels.get(hostId);
		if (tunnel) this.send(tunnel.ws, { type: "ws:frame", id: channelId, data });
	}

	closeWsChannel(hostId: string, channelId: string, code?: number): void {
		const tunnel = this.tunnels.get(hostId);
		if (!tunnel) return;
		tunnel.activeChannels.delete(channelId);
		this.send(tunnel.ws, { type: "ws:close", id: channelId, code });
	}

	handleMessage(hostId: string, data: unknown): void {
		const tunnel = this.tunnels.get(hostId);
		if (!tunnel) return;

		let msg: { type: string; [key: string]: unknown };
		try {
			msg = JSON.parse(String(data));
		} catch {
			return;
		}

		if (msg.type === "pong") {
			tunnel.missedPings = 0;
		} else if (msg.type === "http:response") {
			const pending = tunnel.pendingRequests.get(msg.id as string);
			if (pending) {
				clearTimeout(pending.timer);
				tunnel.pendingRequests.delete(msg.id as string);
				pending.resolve(msg as unknown as TunnelHttpResponse);
			}
		} else if (msg.type === "ws:frame") {
			if (typeof msg.data !== "string") return;
			const clientWs = tunnel.activeChannels.get(msg.id as string);
			if (clientWs?.readyState === 1) {
				if (msg.encoding === "base64") {
					clientWs.send(Buffer.from(msg.data, "base64"));
				} else {
					clientWs.send(msg.data);
				}
			}
		} else if (msg.type === "ws:close") {
			const clientWs = tunnel.activeChannels.get(msg.id as string);
			if (clientWs) {
				tunnel.activeChannels.delete(msg.id as string);
				clientWs.close((msg.code as number) ?? 1000);
			}
		}
	}

	private send(
		ws: WsSocket,
		message: TunnelRequest | Record<string, unknown>,
	): void {
		if (ws.readyState === 1) ws.send(JSON.stringify(message));
	}
}
