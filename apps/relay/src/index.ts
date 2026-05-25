import { serve } from "@hono/node-server";
import { createNodeWebSocket } from "@hono/node-ws";
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { checkHostAccess } from "./access";
import { type AuthContext, verifyJWT } from "./auth";
import * as directory from "./directory";
import { env } from "./env";
import { TunnelManager } from "./tunnel";

const SENSITIVE_QUERY_RE = /([?&])token=[^&\s]+/g;
const redactingLogger = logger((message, ...rest) => {
	const redacted =
		typeof message === "string"
			? message.replace(SENSITIVE_QUERY_RE, "$1token=REDACTED")
			: message;
	console.log(redacted, ...rest);
});

type AppContext = {
	Variables: {
		auth: AuthContext;
		token: string;
		hostId: string;
	};
};

const app = new Hono<AppContext>();
const tunnelManager = new TunnelManager();
const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });

let server: ReturnType<typeof serve> | null = null;
let draining = false;

const handleDrain = async (signal: string) => {
	if (draining) return;
	draining = true;
	console.log(`[relay] ${signal} received, draining tunnels`);
	try {
		server?.close();
		const cleared = await tunnelManager.drain({
			clearDirectory: () =>
				directory.clearStaleEntriesForMachine(
					env.FLY_REGION,
					env.FLY_MACHINE_ID,
				),
		});
		if (cleared > 0) {
			console.log(`[relay] cleared ${cleared} directory entries during drain`);
		}
	} catch (err) {
		console.error("[relay] drain failed", err);
	}
	process.exit(0);
};

process.on("SIGINT", () => void handleDrain("SIGINT"));
process.on("SIGTERM", () => void handleDrain("SIGTERM"));

app.use("*", redactingLogger);
app.use("*", cors());

app.get("/health", (c) => c.json({ ok: true, region: env.FLY_REGION }));

// ── Auth ────────────────────────────────────────────────────────────

function extractToken(c: {
	req: {
		header(name: string): string | undefined;
		query(name: string): string | undefined;
	};
}): string | null {
	const header = c.req.header("Authorization");
	if (header?.startsWith("Bearer ")) return header.slice(7);
	return c.req.query("token") ?? null;
}

async function maybeReplay(
	hostId: string,
): Promise<Record<string, string> | null> {
	if (tunnelManager.hasTunnel(hostId)) return null;
	const owner = await directory.lookup(hostId).catch((err) => {
		console.error("[relay] directory.lookup failed", err);
		return null;
	});
	if (!owner) return null;
	if (
		owner.region === env.FLY_REGION &&
		owner.machineId === env.FLY_MACHINE_ID
	) {
		return null;
	}
	if (owner.region === env.FLY_REGION) {
		return { "fly-replay": `instance=${owner.machineId}` };
	}
	return { "fly-replay": `region=${owner.region}` };
}

const authMiddleware: MiddlewareHandler<AppContext> = async (c, next) => {
	const token = extractToken(c);
	if (!token) return c.json({ error: "Unauthorized" }, 401);

	const auth = await verifyJWT(token, env.NEXT_PUBLIC_API_URL);
	if (!auth) return c.json({ error: "Unauthorized" }, 401);

	const hostId = c.req.param("hostId");
	if (!hostId) return c.json({ error: "Missing hostId" }, 400);

	if (!tunnelManager.hasTunnel(hostId)) {
		const replay = await maybeReplay(hostId);
		if (replay) return c.body(null, 200, replay);
		return c.json({ error: "Host not connected" }, 503);
	}

	const hasAccess = await checkHostAccess(auth, token, hostId);
	if (!hasAccess) return c.json({ error: "Forbidden" }, 403);

	c.set("auth", auth);
	c.set("token", token);
	c.set("hostId", hostId);
	return next();
};

// ── Tunnel ──────────────────────────────────────────────────────────

app.get(
	"/tunnel",
	upgradeWebSocket((c) => {
		const hostId = c.req.query("hostId");
		const token = extractToken(c);
		let registeredWs: Parameters<typeof tunnelManager.register>[2] | null =
			null;

		return {
			onOpen: async (_event, ws) => {
				if (draining) {
					ws.close(TunnelManager.WS_CLOSE_DRAIN, "Server draining for deploy");
					return;
				}

				if (!hostId || !token) {
					ws.close(1008, "Missing hostId or token");
					return;
				}

				const auth = await verifyJWT(token, env.NEXT_PUBLIC_API_URL);
				if (!auth) {
					ws.close(1008, "Unauthorized");
					return;
				}

				const hasAccess = await checkHostAccess(auth, token, hostId);
				if (!hasAccess) {
					ws.close(1008, "Forbidden");
					return;
				}

				if (draining) {
					ws.close(TunnelManager.WS_CLOSE_DRAIN, "Server draining for deploy");
					return;
				}

				await tunnelManager.register(hostId, token, ws);
				if (ws.readyState === 1) registeredWs = ws;
			},
			onMessage: (event) => {
				if (registeredWs && hostId)
					tunnelManager.handleMessage(hostId, event.data);
			},
			onClose: () => {
				if (registeredWs && hostId)
					tunnelManager.unregister(hostId, registeredWs);
			},
			onError: () => {
				if (registeredWs && hostId)
					tunnelManager.unregister(hostId, registeredWs);
			},
		};
	}),
);

app.get("/hosts/:hostId/_whoowns", async (c) => {
	const token = extractToken(c);
	if (!token) return c.json({ error: "Unauthorized" }, 401);
	const auth = await verifyJWT(token, env.NEXT_PUBLIC_API_URL);
	if (!auth) return c.json({ error: "Unauthorized" }, 401);

	const hostId = c.req.param("hostId");
	const replay = await maybeReplay(hostId);
	if (!replay) {
		return tunnelManager.hasTunnel(hostId)
			? c.json({ ok: true, region: env.FLY_REGION })
			: c.json({ error: "Host not connected" }, 503);
	}
	return c.body(null, 200, replay);
});

// ── Host proxy (auth required) ──────────────────────────────────────

app.use("/hosts/:hostId/*", authMiddleware);

app.all("/hosts/:hostId/trpc/*", async (c) => {
	const hostId = c.get("hostId");
	const prefix = `/hosts/${hostId}`;
	const url = new URL(c.req.url);
	const path = `${url.pathname.slice(prefix.length) || "/"}${url.search}`;
	const body = (await c.req.text().catch(() => "")) || undefined;

	const headers: Record<string, string> = {};
	for (const [key, value] of c.req.raw.headers.entries()) {
		if (key !== "host" && key !== "authorization") headers[key] = value;
	}

	try {
		const res = await tunnelManager.sendHttpRequest(hostId, {
			method: c.req.method,
			path,
			headers,
			body,
		});
		return new Response(res.body ?? null, {
			status: res.status,
			headers: res.headers,
		});
	} catch (error) {
		return c.json(
			{ error: error instanceof Error ? error.message : "Proxy error" },
			502,
		);
	}
});

app.get(
	"/hosts/:hostId/*",
	upgradeWebSocket((c) => {
		const url = new URL(c.req.url);
		const hostId = url.pathname.split("/")[2] ?? "";
		const prefix = `/hosts/${hostId}`;
		const path = url.pathname.slice(prefix.length) || "/";
		const query = url.search.slice(1) || undefined;
		let channelId: string | null = null;

		return {
			onOpen: (_event, ws) => {
				try {
					channelId = tunnelManager.openWsChannel(hostId, path, query, ws);
				} catch {
					ws.close(1011, "Failed to open channel");
				}
			},
			onMessage: (event) => {
				if (channelId)
					tunnelManager.sendWsFrame(hostId, channelId, String(event.data));
			},
			onClose: () => {
				if (channelId) tunnelManager.closeWsChannel(hostId, channelId);
			},
			onError: () => {
				if (channelId) tunnelManager.closeWsChannel(hostId, channelId);
			},
		};
	}),
);

setInterval(() => {
	void directory.sweepStale().catch((err) => {
		console.error("[relay] directory.sweepStale failed", err);
	});
}, 30_000);

// ── Start ───────────────────────────────────────────────────────────

try {
	const cleared = await directory.clearStaleEntriesForMachine(
		env.FLY_REGION,
		env.FLY_MACHINE_ID,
	);
	if (cleared > 0) {
		console.log(
			`[relay] cleared ${cleared} stale directory entries on startup`,
		);
	}
} catch (err) {
	console.error("[relay] startup cleanup failed", err);
}

server = serve({ fetch: app.fetch, port: env.RELAY_PORT }, (info) => {
	console.log(
		`[relay] listening on http://localhost:${info.port} (region=${env.FLY_REGION} machine=${env.FLY_MACHINE_ID})`,
	);
});
injectWebSocket(server);
