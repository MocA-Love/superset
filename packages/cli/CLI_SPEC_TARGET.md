# Superset CLI Target Contract

This is the fork-aligned target contract for the distributable `superset`
CLI. It intentionally differs from upstream's raw target spec where the fork
keeps self-host/dev overrides, legacy compatibility, or fork release channels.

## Principles

- Commands shown in help should work, except explicitly marked compatibility
  or planned commands.
- JSON output should be stable enough for scripts and agents.
- Host-service state should be shared with the desktop app under
  `~/.superset`.
- Fork release binaries should update from `MocA-Love/superset`, not the
  upstream release channel.
- Dev/self-host API overrides must remain available through env or stored
  config.

## Command Surface

### Required For v1

```text
auth          login, logout, whoami, check
organization  list, switch
hosts         list
projects      list, create, setup
workspaces    list, create, delete, open, update
tasks         list, get, create, update, delete, statuses list
automations   list, get, create, update, delete, pause, resume, run, logs,
              prompt get, prompt set
agents        list, run
host          start, status, stop
update
```

Root aliases `start`, `status`, and `stop` remain supported for the host
lifecycle commands.

### Compatibility Surface

```text
devices list
--device
```

These stay as compatibility paths while host terminology finishes migrating
through docs, scripts, and user workflows. New docs should prefer `hosts` and
`--host`.

### Planned / Not Yet Shipping

```text
host install
```

This should either become a real launchd/systemd installer or be hidden from
help before a stable CLI release that advertises it.

## Global Options

| Option | Env | Target behavior |
| --- | --- | --- |
| `--json` | | Print structured JSON without depending on TTY state. |
| `--quiet` | | Print compact IDs where possible, otherwise JSON. |
| `--api-key <key>` | `SUPERSET_API_KEY` | Use API key auth for the current invocation. |
| `--device <id>` | `SUPERSET_DEVICE` | Compatibility alias; prefer command-local `--host`. |
| `--help`, `-h` | | Work at root, group, and leaf levels. |
| `--version`, `-v` | | Print the built CLI version. |

Command-local `--host` is the preferred host selector for workspace, project,
and automation commands that can run against a specific machine.

## API And Release Configuration

The fork keeps `SUPERSET_API_URL` / `CLOUD_API_URL` support. Release builds
bake defaults at compile time, but dev/self-host workflows can still set env
or store an `apiUrl` in config.

`SUPERSET_CLI_RELEASE_REPO` defaults to `MocA-Love/superset`. The update
command reads:

```text
https://github.com/MocA-Love/superset/releases/download/cli-latest/
```

for rolling updates, and `cli-v<version>` for pinned installs.

## Local State

Canonical state:

```text
~/.superset/config.json
~/.superset/device.json
~/.superset/host/<organizationId>/manifest.json
~/.superset/host/<organizationId>/host.db
```

Legacy read fallback from `~/superset` remains acceptable only when
`SUPERSET_HOME_DIR` is not set. New writes should target `~/.superset`.

The host manifest must remain compatible with desktop-managed host services
so the CLI and desktop can observe and control the same local host instance.

## Output Conventions

- Success exits `0`; expected command errors exit non-zero through
  `CLIError`.
- Data prints to stdout; errors print to stderr.
- Agent/CI environments should default to JSON unless `--quiet` is passed.
- Commands that can return arrays should support `--quiet` as one ID per
  line where practical.

## Distribution Target

The fork's release workflow should publish:

```text
superset-darwin-arm64.tar.gz
superset-linux-x64.tar.gz
version.txt
```

under both the immutable `cli-v*` release and rolling `cli-latest`. Adding
`linux-arm64` is the next distribution expansion, but should be done by
adjusting the existing fork workflow rather than adding an upstream
`release-cli.yml` that would double-publish releases.

## Open Decisions

- Whether to keep `devices list` indefinitely or hide it after host wording
  is fully migrated.
- Whether `host install` should ship as launchd/systemd setup or be removed
  from help.
- Whether `linux-arm64` is required before the next public CLI release.
- How much of the legacy `CLI_SPEC.md` should be replaced or deleted once
  these split current/target docs are accepted.
