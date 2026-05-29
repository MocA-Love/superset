# Superset CLI Current-State Reference

This document records the fork-aligned CLI surface implemented in
`packages/cli` as of 2026-05-29.

The older `CLI_SPEC.md` is historical. Treat this file as the current
source-derived inventory for the fork.

## Source Of Truth

- CLI package: `packages/cli`
- CLI config: `packages/cli/cli.config.ts`
- Commands: `packages/cli/src/commands/**/command.ts`
- Command metadata: `packages/cli/src/commands/**/meta.ts`
- CLI framework: `packages/cli-framework/src`
- Built version: `0.2.20`

To refresh the command inventory:

```bash
rg --files packages/cli/src/commands | sort
```

## Top-Level Commands

```text
superset agents
superset auth
superset automations
superset devices
superset host
superset hosts
superset organization
superset projects
superset start
superset status
superset stop
superset tasks
superset update
superset workspaces
```

Aliases:

| Alias | Target |
| --- | --- |
| `auto` | `automations` |
| `org` | `organization` |
| `t` | `tasks` |
| `ws` | `workspaces` |

`start`, `status`, and `stop` are root aliases for `host start`,
`host status`, and `host stop`.

## Implemented Command Tree

```text
agents
  list
  run
auth
  check
  login
  logout
  whoami
automations
  create
  delete
  get
  list
  logs
  pause
  prompt
    get
    set
  resume
  run
  update
devices
  list
host
  install
  start
  status
  stop
hosts
  list
organization
  list
  members
    list
  switch
projects
  create
  list
  setup
tasks
  create
  delete
  get
  list
  statuses
    list
  update
update
workspaces
  create
  delete
  list
  open
  update
```

## Global Options

| Option | Env | Notes |
| --- | --- | --- |
| `--json` | | Prints structured JSON. Auto-on under CI/agent envs. |
| `--quiet` | | Prints compact IDs where command output supports it. |
| `--device <id>` | `SUPERSET_DEVICE` | Compatibility host override. New workspace commands prefer `--host`. |
| `--api-key <key>` | `SUPERSET_API_KEY` | Uses a Superset API key instead of OAuth login. |
| `--help`, `-h` | | Framework-provided help. |
| `--version`, `-v` | | Framework-provided version output. |

Agent/CI mode defaults output to JSON when the framework detects a
non-empty CI or agent environment.

## Runtime State

The canonical runtime state lives under `SUPERSET_HOME_DIR`, defaulting to
`~/.superset`. The CLI can still read selected legacy files from
`~/superset` when `SUPERSET_HOME_DIR` is not set.

| Path | Purpose |
| --- | --- |
| `~/.superset/config.json` | OAuth/API key config, active organization, optional API URL. |
| `~/.superset/device.json` | Legacy device identity fallback. |
| `~/.superset/host/<organizationId>/manifest.json` | Host service PID, endpoint, token, and organization. |
| `~/.superset/host/<organizationId>/host.db` | Host-service SQLite database. |

## Host Targeting

Workspace and project commands resolve a host target before calling the
host-service tRPC surface.

- `--host <id>` targets a specific host.
- `--device <id>` remains a deprecated compatibility alias where wired.
- `--local` forces the local machine.
- When no explicit host is provided, commands use local identity or legacy
  `device.json` depending on the command path.

Local targets use the manifest endpoint over loopback with the manifest
auth token. Remote targets use the relay URL and a host routing key.

## Build-Time Configuration

`cli.config.ts` bakes these constants into release binaries:

| Env | Default |
| --- | --- |
| `RELAY_URL` | `https://relay.superset.sh` |
| `SUPERSET_API_URL` / `CLOUD_API_URL` | `https://api.superset.sh` |
| `SUPERSET_WEB_URL` | `https://app.superset.sh` |
| `SUPERSET_CLI_RELEASE_REPO` | `MocA-Love/superset` |
| `SUPERSET_VERSION` | `0.2.20` |

Dev builds still read process env, and stored config may carry an
`apiUrl` for fork/self-host workflows.

## Distribution

The fork builds standalone tarballs through `.github/workflows/build-cli.yml`.
The current matrix publishes:

| Target | Runner |
| --- | --- |
| `darwin-arm64` | `macos-14` |
| `linux-x64` | `ubuntu-latest` |

The workflow also creates a prerelease `cli-v*` release and updates the
rolling `cli-latest` release. `superset update` downloads from
`MocA-Love/superset` by default.

`packages/cli/scripts/build-dist.ts` assembles the CLI binary, host-service
runtime, native modules, migrations, and wrapper scripts into a tarball.

## Known Gaps

- `host install` still returns "Not implemented yet".
- The command tree still exposes legacy `devices list` compatibility.
- `CLI_SPEC.md` is stale and should not be used as the current contract.
- The build matrix does not yet publish `linux-arm64`.
- Homebrew publishing is not enabled for the fork channel.
