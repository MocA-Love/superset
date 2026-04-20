# @superset/superset-browser-mcp

Small stdio MCP server that bridges an LLM session to a Superset desktop app
browser pane. Superset ships the compiled binary at
`<app>/Contents/Resources/resources/superset-browser-mcp/superset-browser-mcp`;
`claude mcp add superset-browser -s user -- <that path>` registers it into
Claude Code, `codex mcp add superset-browser -- <that path>` into Codex.

## What it does (and what it doesn't)

Actual browser automation — click, navigate, screenshot, DOM inspection — is
delegated to mature external CDP (Chrome DevTools Protocol) MCPs:

- [`chrome-devtools-mcp`](https://github.com/ChromeDevTools/chrome-devtools-mcp)
- [`browser-use`](https://github.com/browser-use/browser-use)
- [`playwright-mcp`](https://github.com/microsoft/playwright-mcp)

This MCP's only job is **binding routing**: give the LLM a URL that scopes
CDP down to the one Superset pane that the user attached to the session.

Tools:

- `get_cdp_endpoint` — returns `{ webSocketDebuggerUrl, httpBase, targetId, … }`
  for the pane currently bound to this LLM session. Plug those into any
  external CDP MCP and it only sees that pane.
- `get_connected_pane` — returns `{ bound, paneId, url, title, sessionId }`
  as a sanity check before handing the endpoint to another tool.

## Architecture

```
Claude / Codex session
        │  (stdio tool call: get_cdp_endpoint)
        ▼
packages/superset-browser-mcp  (this package)
        │  HTTP over loopback, ~/.superset/browser-mcp.json
        ▼
apps/desktop main process
  ├── session resolver (PPID → terminal pane → LLM session)
  ├── binding store (sessionId ↔ paneId)
  └── CDP filter proxy
        │  ws(s)://…/cdp/<token>/devtools/page/<targetId>
        ▼
Chromium --remote-debugging-port   (random port)
        │  filter: only the bound pane's target is visible
        ▼
External CDP MCP (chrome-devtools-mcp / browser-use / …)
```

## Flow

1. User opens a browser pane in Superset and hits **Connect**, binding it to
   their running Claude / Codex terminal session. The binding is persisted in
   Superset's local DB so it survives restarts.
2. Claude / Codex spawns this MCP. It talks to the Superset bridge over the
   loopback port written to `~/.superset/browser-mcp.json` (workspace-scoped
   via `SUPERSET_HOME_DIR`).
3. `get_cdp_endpoint` returns a per-session-token URL pointing at the filter
   proxy. The LLM uses it to configure chrome-devtools-mcp / browser-use /
   etc. from the same session.
4. The external CDP client sees exactly one page target — the bound pane —
   via `/json/list`. Sibling panes and the workspace shell are invisible.
5. Re-binding in the UI re-routes the filtered endpoint to the new pane; the
   next CDP connection picks up the swap automatically.

## Dev notes

Source lives at `src/bin.ts`; tools at `src/tools/index.ts`. The binary is
produced by `bun build --compile` and copied into the Electron app via
`extraResources` — see the desktop app's `electron-builder.ts`.

For the full roadmap (including the PRs that shipped this stack) see
`plan.md` at the repo root.
