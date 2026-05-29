/**
 * Workspace Service — Desktop Entry Point
 *
 * Starts the host-service HTTP server on a port assigned by the coordinator.
 * The coordinator polls health.check to know when it's ready.
 */

import { serve } from "@hono/node-server";
import {
	createApp,
	installProcessSafetyNet,
	JwtApiAuthProvider,
	LocalGitCredentialProvider,
	LocalModelProvider,
	PskHostAuthProvider,
} from "@superset/host-service";
import {
	initTerminalBaseEnv,
	resolveTerminalBaseEnv,
} from "@superset/host-service/terminal-env";
import { connectRelay } from "@superset/host-service/tunnel";
import { loadToken } from "lib/trpc/routers/auth/utils/auth-functions";
import { writeManifest } from "main/lib/host-service-manifest";
import { env } from "./env";

const SHUTDOWN_GRACE_MS = 3_000;
const WATCHDOG_INTERVAL_MS = 2_000;

type Server = ReturnType<typeof serve>;

async function main(): Promise<void> {
	const serverRef: { current: Server | null } = { current: null };
	let shuttingDown = false;
	const shutdown = (reason: string) => {
		if (shuttingDown) return;
		shuttingDown = true;
		console.log(`[host-service] shutdown (${reason}), draining connections`);
		const server = serverRef.current;
		if (!server) {
			process.exit(0);
		}
		server.close();
		const forceExit = setTimeout(() => {
			const httpServer = server as unknown as {
				closeAllConnections?: () => void;
			};
			httpServer.closeAllConnections?.();
			process.exit(0);
		}, SHUTDOWN_GRACE_MS);
		forceExit.unref();
	};

	process.on("SIGTERM", () => shutdown("SIGTERM"));
	process.on("SIGINT", () => shutdown("SIGINT"));

	const parentPid = Number(process.env.HOST_PARENT_PID);
	if (Number.isInteger(parentPid) && parentPid > 1) {
		const interval = setInterval(() => {
			if (!isParentAlive(parentPid)) {
				clearInterval(interval);
				shutdown("parent-exit");
			}
		}, WATCHDOG_INTERVAL_MS);
		interval.unref();
	}

	const terminalBaseEnv = await resolveTerminalBaseEnv();
	initTerminalBaseEnv(terminalBaseEnv);

	const authProvider = new JwtApiAuthProvider({
		getSessionToken: async () => {
			const { token } = await loadToken();
			return token ?? env.AUTH_TOKEN;
		},
		apiUrl: env.SUPERSET_API_URL,
	});

	const { app, injectWebSocket, api } = createApp({
		config: {
			organizationId: env.ORGANIZATION_ID,
			dbPath: env.HOST_DB_PATH,
			cloudApiUrl: env.SUPERSET_API_URL,
			migrationsFolder: env.HOST_MIGRATIONS_FOLDER,
			allowedOrigins: [
				`http://localhost:${env.DESKTOP_VITE_PORT}`,
				`http://127.0.0.1:${env.DESKTOP_VITE_PORT}`,
			],
			hostServiceSecret: env.HOST_SERVICE_SECRET,
		},
		providers: {
			auth: authProvider,
			hostAuth: new PskHostAuthProvider(env.HOST_SERVICE_SECRET),
			credentials: new LocalGitCredentialProvider(),
			modelResolver: new LocalModelProvider(),
		},
	});

	const startedAt = Date.now();
	const server = serve(
		{ fetch: app.fetch, port: env.HOST_SERVICE_PORT, hostname: "127.0.0.1" },
		(info: { port: number }) => {
			// Install only after the server is listening so startup throws still
			// reach `main().catch(...)` and exit with a non-zero code.
			installProcessSafetyNet();

			if (env.ORGANIZATION_ID) {
				try {
					writeManifest({
						pid: process.pid,
						endpoint: `http://127.0.0.1:${info.port}`,
						authToken: env.HOST_SERVICE_SECRET,
						startedAt,
						organizationId: env.ORGANIZATION_ID,
					});
				} catch (error) {
					console.error("[host-service] Failed to write manifest:", error);
				}
			}

			if (env.RELAY_URL && env.ORGANIZATION_ID) {
				void connectRelay({
					api,
					relayUrl: env.RELAY_URL,
					localPort: info.port,
					organizationId: env.ORGANIZATION_ID,
					authProvider,
					hostServiceSecret: env.HOST_SERVICE_SECRET,
				});
			}
		},
	);
	serverRef.current = server;
	injectWebSocket(server);
}

function isParentAlive(parentPid: number): boolean {
	try {
		process.kill(parentPid, 0);
		return process.ppid === parentPid;
	} catch {
		return false;
	}
}

void main().catch((error) => {
	console.error("[host-service] Failed to start:", error);
	process.exit(1);
});
