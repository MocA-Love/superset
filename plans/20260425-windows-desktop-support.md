# Windows Desktop Support Plan (Issue #273)

## Goal

Ship a Windows x64 NSIS installer of the fork so Windows users can install,
launch, and use Superset with the core workspace/terminal/chat flow intact —
even though agent-hook and a handful of macOS-specific integrations still
need native PowerShell/Win32 implementations.

## Baseline (pre-PR)

- `apps/desktop/electron-builder.ts` already defines a `win` NSIS x64 target
  but `npmRebuild: true`, publish pointing at upstream, and NSIS shortcuts
  are missing.
- `.github/workflows/build-desktop.yml` has macOS + Linux jobs only.
- Native runtime (terminal, process-tree, browser-mcp, language servers,
  `@libsql/*`, `@parcel/watcher-*`, `@ast-grep/napi-*`) is already Windows-
  aware — that part of the stack just works.
- `setup.sh` / `teardown.sh`, `askpass.sh`, and every agent-setup template
  (notify / copilot / cursor / gemini / codex) assume `#!/bin/bash` + POSIX
  utilities.
- Electron startup code assumes macOS / Linux for `titleBarStyle` and
  `app.disableHardwareAcceleration()`.
- No `ELECTRON_RUN_AS_NODE` guard; `file://` ASAR loading breaks dynamic
  imports on Windows; crossorigin attributes silently fail on ASAR file://.
- Upstream `superset-sh/superset#2100` (startup hardening) and `#2196`
  (agent hook + PowerShell templates) are **open** and **conflicting**;
  not merged. Fork needs to take the relevant pieces in-tree.

## Phases

### Phase 1 — Startup & build foundation (this PR)

Adapted from upstream PR #2100 with fork-specific adjustments:

- `scripts/postinstall.sh` → `scripts/postinstall.mjs` (keeps fork's `$CI`
  early-exit logic, makes install:deps non-fatal on Windows).
- `electron-builder.ts`: `npmRebuild: process.platform !== "win32"`, NSIS
  desktop/Start-menu shortcuts.
- `electron.vite.config.ts`: rollup banner to delete
  `ELECTRON_RUN_AS_NODE` before any `require("electron")`; renderer picks
  up `stripCrossOriginPlugin`.
- `copy-native-modules.ts`: Windows uses `rmSync(.., { recursive, force })`
  to remove Bun-created directory junctions.
- `factories/app/setup.ts`: disable GPU hardware acceleration on Windows in
  addition to Linux.
- `window-loader.ts`: Windows prod loads via `superset-app://app/index.html`
  so ES module dynamic imports work (file:// breaks them on Windows).
- `main/index.ts`: register `superset-app` custom scheme + handler; Windows
  outbound CORS bypass for `api.superset.sh`, PostHog, Sentry.
- `main/windows/main.ts`: Windows gets `titleBarOverlay` (so close/minimize
  are actually clickable) and renderer console forwarding for debugging;
  `trafficLightPosition` stays macOS-only.
- `vite/helpers.ts`: `defineEnv` uses `||` (empty string fallback) and
  exports `stripCrossOriginPlugin`.

### Phase 2 — macOS-specific fallbacks (this PR)

- `play-sound.ts`: PowerShell `System.Media.SoundPlayer` / `MediaPlayer`
  branch for Windows. Volume becomes mute-only on SoundPlayer since it has
  no volume API.
- `ScriptsEditor.tsx`: file input accepts `.ps1 / .cmd / .bat` in addition
  to `.sh / .bash / .zsh / .command`.
- Auto-updater already works on Windows via the fork's GitHub-API check
  path; upstream `IS_AUTO_UPDATE_PLATFORM` is only consulted when fork
  path is disabled.

### Phase 3 — Agent / host-service flow (this PR, minimal)

- `agent-setup/index.ts`: skip wrapper/hook setup on Windows with a log
  line. The bash templates and `find_real_binary` helper are not ported
  yet; agents run from the user's PATH without Superset wrappers.
- `host-service/.../setup-terminal.ts` + `runtime/teardown/teardown.ts`:
  Windows looks for `setup.ps1 / .cmd / .bat` (resp. teardown) and spawns
  them via `powershell.exe -File` / `cmd.exe /c`. POSIX candidates stay
  `setup.sh` / `teardown.sh`.
- `providers/git/.../askpass.ts`: Windows produces a `.cmd` helper via
  `findstr /I "^Username"`; POSIX keeps the `.sh` one.

### Phase 4 — CI (this PR)

- `.github/workflows/build-desktop.yml`: new `build-windows` job on
  `windows-latest` that installs deps, runs `compile:app`, builds
  `superset-browser-mcp.exe` (Bun doesn't run lifecycle hooks), then runs
  `electron-builder --win --publish never`. Verifies `*.exe` and
  `latest.yml` exist. Uploads both + blockmap as artifacts.
- `shell: bash` default on the Windows job so the bash-written release
  scripts still run (Git Bash is pre-installed on windows-latest runners).
- `git config --global core.longpaths true` to avoid 260-char path errors.

## Out of scope (tracked as follow-ups)

- **PowerShell hook templates** for notify/copilot/cursor/gemini/codex. The
  current notify-hook is 100+ lines of bash/grep/tr/curl; a faithful `.ps1`
  port lands in a dedicated PR so it can be reviewed in isolation.
- **Agent wrappers on Windows** (`find_real_binary`, PATH injection,
  sleep-inhibitor). Needs a PowerShell-side implementation; see #273.
- **Windows auto-update (NSIS) polish** — the fork's manual-download flow
  already works, but in-app install-on-quit for Windows is not implemented.
- **Mica / Acrylic vibrancy** as a Windows 11 fallback for the macOS
  NSVisualEffectView blur.
- **Deep-link dev registration** on Windows: `patch-dev-protocol.ts` is
  macOS-only; production deep links work via `app.setAsDefaultProtocolClient`
  + NSIS registry writes, but dev mode does not.
- **Known-limitations note** in `BUILDING.md` / README (separate docs PR).

## Verification

- `bun run typecheck` must pass across the monorepo.
- `build-windows` job must succeed on `windows-latest` and produce a
  `Superset-<version>-x64.exe` plus `latest.yml`.
- Smoke test on Windows 11: installer runs, app launches, main window is
  visible with working close/minimize, workspace list loads.
- macOS / Linux behavior must be unchanged — every new branch is gated on
  `process.platform === "win32"` or `PLATFORM.IS_WINDOWS`.
