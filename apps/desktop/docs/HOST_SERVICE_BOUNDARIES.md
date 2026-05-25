# Host Service Boundaries

API shapes and boundaries between the host service, the Electron desktop layer, and the tray.

---

## 1. Host Service (`packages/host-service`)

### `createApp()` — the sole entry point

```ts
createApp({
  config: {
    dbPath: string,            // where the SQLite database lives
    cloudApiUrl: string,       // where the cloud API is
    migrationsPath: string,    // where Drizzle migration files live
    allowedOrigins: string[],  // CORS allowlist
  },
  providers: {
    auth: ApiAuthProvider,                // outbound: how to authenticate with the cloud API
    hostAuth: HostAuthProvider,           // inbound: how to validate requests to this service
    credentials: GitCredentialProvider,   // how to get git/GitHub credentials
    modelResolver: ModelProviderResolver, // how to resolve AI model credentials
  },
});
```

All fields required. No optional fields. No defaults that assume a desktop environment.

**Config** = static values (strings, paths, URLs). **Providers** = injectable behavior (interfaces with different implementations per deployment).

**Not config, not providers:**

- `hostId` / `hostName` — generated internally by the host service from machine identity
- Version — the service reads its own version from package.json, not from a passed-in string.

### Provider interfaces

```ts
interface ApiAuthProvider {
  getHeaders(): Promise<Record<string, string>>;
}

interface HostAuthProvider {
  validate(request: Request): Promise<boolean>;
  validateToken(token: string): Promise<boolean>;
}

interface GitCredentialProvider {
  getToken(host: string): Promise<string | null>;
}

interface ModelProviderResolver {
  resolve(cwd: string): Promise<RuntimeEnv>;
  // Returns env vars — does NOT mutate process.env
}
```

### tRPC endpoints

**Unauthenticated (liveness probes):**

```ts
health.check → { status: "ok" }
```

**Authenticated (PSK) — host identity and metadata:**

This is how the tray gets the information it needs. `host.info` is the single source of truth for "who is this host" — no metadata passed through the Electron layer.

```ts
host.info → {
  hostId: string,
  hostName: string,
  organization: {
    id: string,
    name: string,
    slug: string,
  },
  version: string,    // from package.json
  platform: string,
  uptime: number,
}
```

**Authenticated (PSK) — workspace and project management:**

```ts
workspace.create → ...
workspace.delete → ...
workspace.list   → ...
project.remove   → ...   // renamed from removeFromDevice
```

**Authenticated (PSK) — WebSocket routes:**

```ts
terminal/*       → WebSocket
filesystem/*     → WebSocket
```

### What the host service is NOT

`createApp()` is a factory — it wires config + providers into a Hono server and returns it. There is no "host service manager" inside the package. The complexity of the current `createApp()` (~150 lines) is just plumbing: create DB, create git factory, create API client, register routes. Provider construction is one-liners (`new PskHostAuthProvider(secret)`, etc.) — the callers are simple.

---

## 2. Electron Coordinator (`apps/desktop`)

Manages host service child processes. This is the only complex piece on the Electron side.

### Interface

```ts
interface HostServiceCoordinator {
  // Lifecycle
  start(organizationId: string, config: SpawnConfig): Promise<{ port: number; secret: string }>;
  stop(organizationId: string): void;
  restart(organizationId: string, config: SpawnConfig): Promise<{ port: number; secret: string }>;
  stopAll(): void;

  // Queries
  getConnection(organizationId: string): { port: number; secret: string } | null;
  getProcessStatus(organizationId: string): ProcessStatus;
  getActiveOrganizationIds(): string[];

  // Events
  on(event: "status-changed", handler: (e: StatusEvent) => void): void;
}

interface SpawnConfig {
  authToken: string;
  cloudApiUrl: string;
  dbPath: string;
  migrationsPath: string;
  allowedOrigins: string[];
}

type ProcessStatus = "starting" | "running" | "degraded" | "restarting" | "stopped";

interface StatusEvent {
  organizationId: string;
  status: ProcessStatus;
  previousStatus: ProcessStatus | null;
}
```

### Per-instance state

After a service is running, the coordinator holds:

```ts
{
  pid: number,       // the OS process ID — used for liveness checks and SIGTERM
  port: number,      // from ready message (spawned) or manifest (adopted)
  secret: string,    // PSK for authenticating with this instance
}
```

That's the steady-state. During spawn, the coordinator picks a free port, passes it to the host service as config (env var), then polls `health.check` on that port until the service is up. No Node IPC channel needed — the host service just starts on the port it's told. Once healthy, the coordinator records the pid/port/secret and keeps host-service coupled to Electron: `before-quit` calls `stopAll()`, and the child also has a parent-pid watchdog so it exits after an Electron crash.

### Where the complexity lives

The coordinator is the Electron-side process owner:

| Concern | Why it's unavoidable |
|---------|---------------------|
| Spawn + health poll | Must start the child, poll health.check until ready, handle timeout |
| Restart with backoff | Crashed services need exponential backoff, not immediate retry |
| Pending start dedup | Concurrent `start()` calls for the same org must coalesce |
| Parent watchdog | Children need to self-exit if Electron is force-killed |

The older manifest-adoption and release-vs-stop paths were removed once PTY survival moved to the detached `pty-daemon`. The coordinator now only manages Electron-owned host-service processes.

### What the coordinator does NOT hold

| Data | Where it lives instead |
|------|----------------------|
| Organization name/metadata | Host service (`host.info` endpoint) |
| Auth token, cloud API URL | Passed per-call as `SpawnConfig`, not stored |
| Service version | Host service (`host.info` endpoint) |
| Uptime | Host service (`host.info` endpoint) |
| Compatibility / pending restart | Derived at query time by comparing `host.info` version vs app version |

### Config passing

```ts
// Before (mutate-then-call anti-pattern)
manager.setAuthToken(token);
manager.setCloudApiUrl(url);
manager.setOrganizationName(organizationId, name);
await manager.start(organizationId);

// After (pass config per-call)
await coordinator.start(organizationId, {
  authToken: token,
  cloudApiUrl: url,
  dbPath: path.join(orgDir, "host.db"),
  migrationsPath: getMigrationsPath(),
  allowedOrigins: [`http://localhost:${vitePort}`],
});
```

---

## 3. Tray (`apps/desktop`)

Pure view. Reads from two sources, writes to coordinator.

### Data sources

```
From host.info (HTTP to each service, authenticated with PSK):
  - organization.name        → menu section header
  - version                  → display label
  - uptime                   → display label

From coordinator (in-process):
  - status                   → "Running" / "Starting..." / "Degraded"
  - active org count         → controls host-service submenu label
```

### Actions

```
Restart                  → coordinator.restart(organizationId, config)
Stop                     → coordinator.stop(organizationId)
Close Superset           → coordinator.stopAll() + app.exit()
Quit Superset Completely → coordinator.stopAll() + terminal-host teardown + app.exit()
```

### Menu structure

```
Host Service (N)
├── <org name>                          ← from host.info
│   ├── Running (v1.2.3)               ← status from coordinator, version from host.info
│   ├── Uptime: 2h 15m                 ← from host.info
│   ├── Restart
│   └── Stop
├── ─────────
├── <another org>
│   └── ...
├── ─────────
├── Open Superset
├── Settings
├── Check for Updates
├── ─────────
├── Close Superset
├── ─────────
└── Quit Superset Completely
```

---

## 4. Renderer HostServiceProvider (`apps/desktop`)

Queries the coordinator for connection info, then talks directly to host services over HTTP/WS.

```ts
// From coordinator (via tRPC IPC)
const { port, secret } = await trpc.hostService.getConnection.query({ organizationId });

// Direct to host service (HTTP/WS)
const client = createHostServiceClient(port, secret);
await client.workspace.list.query();
```

The provider maintains `Map<organizationId, { port, url, client }>` — just connection info. No metadata caching.

---

## 5. Manifest (`apps/desktop` — Electron-only concept)

On-disk JSON file per org. Written by host-service after it starts. Electron no longer reads it for adoption on next app launch; it is kept for CLI discovery and for `coordinator.reset()` to kill a stale pid if recovery is needed.

```ts
interface Manifest {
  pid: number,
  endpoint: string,          // e.g. "http://127.0.0.1:4832"
  authToken: string,         // PSK secret for this instance
  startedAt: number,
  organizationId: string,
}
```

Minimal — just enough for local discovery. No version or protocol fields.

Lives at `~/.superset/host/<organizationId>/manifest.json`. Remote deployments don't use manifests.

---

## 6. What moves where

### Out of `packages/host-service`

| Item | Current location | Moves to | Reason |
| --- | --- | --- | --- |
| `process.resourcesPath` / `ELECTRON_RUN_AS_NODE` | `db.ts` | Electron entry point | `migrationsPath` is now required config |
| `ORGANIZATION_ID` from `process.env` | `health.ts` | Removed | Org info served via `host.info`, fetched from cloud at registration |
| `LocalModelProvider` as default | `app.ts` | Injected by caller | `modelResolver` is required, no default |
| `LocalGitCredentialProvider` as default | `app.ts` | Injected by caller | `credentials` is required, no default |
| Default `~/.superset/host.db` | `app.ts` | Injected by caller | `dbPath` is required, no default |
| `~/.superset/chat-anthropic-env.json` | `anthropic-runtime-env.ts` | Moves with `LocalModelProvider` | Desktop-only path |
| macOS Keychain reads | `resolveAnthropicCredential.ts` | Moves with `LocalModelProvider` | macOS-only |
| `~/.claude/` credential reads | `resolveAnthropicCredential.ts` | Moves with `LocalModelProvider` | Claude Desktop-only |
| `project.removeFromDevice` | `project.ts` | Rename to `project.remove` | "Device" framing is wrong |
| `process.env` mutations in `applyRuntimeEnv()` | `runtime-env.ts` | Model providers return env, don't mutate | Dangerous in multi-tenant context |
| `health.info` (current combined endpoint) | `health.ts` | Split into `health.check` + `host.info` | Liveness vs metadata are different concerns |

### Stays in `packages/host-service`

| Item | Why |
| --- | --- |
| Workspace CRUD | Core host responsibility |
| Host registration (renamed from device) | Host registers itself as a network node |
| Terminal PTY management | Core host responsibility |
| Filesystem watching | Core host responsibility |
| Git operations | Core host responsibility |
| AI chat runtime | Core host responsibility |
| `health.check` (liveness only) | Every service needs this |
| `host.info` (new, authenticated) | Host is the source of truth for its own identity |
| `PskHostAuthProvider` | Pure validation, works everywhere |
| `CloudGitCredentialProvider` / `CloudModelProvider` | Cloud-backed, environment-agnostic |
| Shell resolution (`process.platform` in terminal) | Terminals inherently need to know the OS |
| `terminal_sessions` table | Session tracking is host-service state |

### Gaps to fix in standalone `serve.ts`

| Gap | Fix |
| --- | --- |
| `auth` / `cloudApiUrl` not passed | Make required — standalone needs cloud connectivity |
| `credentials` defaults to `LocalGitCredentialProvider` | Use `CloudGitCredentialProvider` |
| `modelResolver` defaults to `LocalModelProvider` | Use `CloudModelProvider` |
| No terminal session reconciliation at startup | Mark orphaned `"active"` sessions as `"disposed"` on boot |
| `health.info` unauthenticated | Move metadata to `host.info` behind PSK auth |

---

## 7. Entry point examples

### Electron

```ts
// apps/desktop/src/main/host-service/index.ts
import { createApp, PskHostAuthProvider, JwtApiAuthProvider } from "@superset/host-service";
import { LocalGitCredentialProvider } from "@superset/host-service/providers/desktop";
import { LocalModelProvider } from "@superset/host-service/providers/desktop";

createApp({
  config: {
    dbPath: path.join(orgDir, "host.db"),
    cloudApiUrl: env.CLOUD_API_URL,
    migrationsPath: app.isPackaged
      ? path.join(process.resourcesPath, "resources/host-migrations")
      : path.join(app.getAppPath(), "../../packages/host-service/drizzle"),
    allowedOrigins: [`http://localhost:${desktopVitePort}`],
  },
  providers: {
    auth: new JwtApiAuthProvider(authToken),
    hostAuth: new PskHostAuthProvider(secret),
    credentials: new LocalGitCredentialProvider(),
    modelResolver: new LocalModelProvider(),
  },
});
```

### Standalone

```ts
// packages/host-service/src/serve.ts
import { createApp, PskHostAuthProvider, JwtApiAuthProvider,
         CloudGitCredentialProvider, CloudModelProvider } from "./index";

createApp({
  config: {
    dbPath: env.HOST_DB_PATH,
    cloudApiUrl: env.CLOUD_API_URL,
    migrationsPath: join(import.meta.dirname, "../../drizzle"),
    allowedOrigins: env.CORS_ORIGINS,
  },
  providers: {
    auth: new JwtApiAuthProvider(env.AUTH_TOKEN),
    hostAuth: new PskHostAuthProvider(env.HOST_SERVICE_SECRET),
    credentials: new CloudGitCredentialProvider(),
    modelResolver: new CloudModelProvider(),
  },
});
```

No `if (process.resourcesPath)`. No `if (platform() === "darwin")`. No `~/.superset` defaults. The host service is a pure server; the caller decides how it's configured.
