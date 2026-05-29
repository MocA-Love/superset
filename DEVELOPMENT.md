# Developing Superset

This guide is for contributors building this fork from source. If you just want to use Superset, download the latest fork build from [MocA-Love/superset releases](https://github.com/MocA-Love/superset/releases/latest).

## Prerequisites

| Tool | Install |
|:-----|:--------|
| [Bun](https://bun.sh/) (v1.0+) | `curl -fsSL https://bun.sh/install \| bash` |
| [Docker](https://docs.docker.com/get-docker/) | Docker Desktop or OrbStack |
| `jq` | `brew install jq` |
| [Caddy](https://caddyserver.com/docs/install) | `brew install caddy && caddy trust` |
| Git 2.20+ and [`gh`](https://cli.github.com/) | `brew install gh` |

macOS is the primary local development platform. Windows builds are available from the fork release workflow, but local development on Windows is still preview-quality.

## Run It

```bash
git clone https://github.com/MocA-Love/superset.git
cd superset
./.superset/setup.local.sh
bun run dev
```

You do not need a Neon account, Stripe keys, or other third-party credentials for local development. `.env.local.example` ships fake placeholders that pass env validation, and `setup.local.sh` runs against a local Docker stack.

### What `setup.local.sh` Does

1. Copies `.env.local.example` to `.env` when `.env` does not exist.
2. Allocates a per-workspace port range so multiple worktrees do not collide.
3. Starts Postgres, neon-proxy, and Electric through Docker Compose.
4. Runs `bun install` and `bun run db:migrate`.
5. Seeds a `Local Admin` dev account through `bun run db:seed-dev`.
6. Writes a gitignored `.superset/config.local.json` overlay so future worktrees use the same local setup flow.

To tear the local DB stack down:

```bash
./.superset/teardown.local.sh
```

### Signing In

After `bun run dev`, open the web or desktop app and use the development sign-in button. You can also use the seeded credentials directly:

- Email: `admin@local.test`
- Password: `supersetdev`

The dev sign-in button and email/password auth are gated on `NODE_ENV=development`.

## Manual Setup

If you need to point at real Neon or third-party services instead of the local Docker stack:

```bash
cp .env.example .env
cp Caddyfile.example Caddyfile
bun install
bun run dev
```

Fill in the real service credentials in `.env` before running the app.

## Building the Desktop App

```bash
cd apps/desktop
SUPERSET_WORKSPACE_NAME=superset bun run compile:app
bun run copy:native-modules
bun run validate:native-runtime
bun run build:browser-mcp
SUPERSET_WORKSPACE_NAME=superset bun run build
open release
```

The fork release flow has additional signing, packaging, and artifact checks. See `AGENTS.md` for the full release process.

## Common Commands

```bash
bun dev                # Start the main local dev stack
bun test               # Run tests
bun run lint:fix       # Fix lint + format
bun run typecheck      # Type-check all packages
bun run build          # Build the desktop package
```

See [`AGENTS.md`](./AGENTS.md) for repo structure, monorepo conventions, and database migration workflow.

## Troubleshooting

- `caddy trust` prompts for sudo: expected once per machine. Without it, Chromium rejects `https://localhost:*` with `ERR_CERT_AUTHORITY_INVALID`.
- Port collision: `setup.local.sh` allocates a fresh port window per worktree. Re-run it if the workspace predates the local setup flow.
- DB connection errors after pulling main: re-run `./.superset/setup.local.sh` so the local stack and migrations are refreshed.
- Stuck Docker stack: run `./.superset/teardown.local.sh`, then run setup again.

## Contributing

See [`CONTRIBUTING.md`](./CONTRIBUTING.md) for the PR process and code-of-conduct expectations.
