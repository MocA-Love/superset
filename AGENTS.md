# Superset Monorepo Guide

Guidelines for agents and developers working in this repository.

## Structure

Bun + Turbo monorepo with:
- **Apps**:
  - `apps/web` - Main web application (app.superset.sh)
  - `apps/marketing` - Marketing site (superset.sh)
  - `apps/admin` - Admin dashboard
  - `apps/api` - API backend
  - `apps/desktop` - Electron desktop application
  - `apps/docs` - Documentation site
  - `apps/mobile` - React Native mobile app (Expo)
- **Packages**:
  - `packages/ui` - Shared UI components (shadcn/ui + TailwindCSS v4).
    - Add components: `npx shadcn@latest add <component>` (run in `packages/ui/`)
  - `packages/db` - Drizzle ORM database schema
  - `packages/auth` - Authentication
  - `packages/trpc` - Shared tRPC definitions
  - `packages/shared` - Shared utilities
  - `packages/mcp` - MCP integration
  - `packages/desktop-mcp` - Desktop MCP server
  - `packages/local-db` - Local SQLite database
  - `packages/durable-session` - Durable session management
  - `packages/email` - Email templates/sending
  - `packages/scripts` - CLI tooling
- **Tooling**:
  - `tooling/typescript` - Shared TypeScript configs

## Tech Stack

- **Package Manager**: Bun (no npm/yarn/pnpm)
- **Build System**: Turborepo
- **Database**: Drizzle ORM + Neon PostgreSQL
- **UI**: React + TailwindCSS v4 + shadcn/ui
- **Code Quality**: Biome (formatting + linting at root)
- **Next.js**: Version 16 - NEVER create `middleware.ts`. Next.js 16 renamed middleware to `proxy.ts`. Always use `proxy.ts` for request interception.

## Common Commands

```bash
# Development
bun dev                    # Start all dev servers
bun test                   # Run tests
bun build                  # Build all packages

# Code Quality
bun run lint               # Check for lint issues (no changes)
bun run lint:fix           # Fix auto-fixable lint issues
bun run format             # Format code only
bun run format:check       # Check formatting only (CI)
bun run typecheck          # Type check all packages

# Maintenance
bun run clean              # Clean root node_modules
bun run clean:workspaces   # Clean all workspace node_modules
```

## MocA-Love/superset フォーク向け: Desktop アプリのビルドとリリース

このフォーク固有のビルド手順とリリースフロー。本家 (superset-sh/superset) とは配布先やチャネルが異なる。

### ローカル開発

`apps/desktop` の dev 起動:

```bash
cd apps/desktop
SUPERSET_WORKSPACE_NAME=superset SKIP_ENV_VALIDATION=1 DESKTOP_VITE_PORT=5222 bun run dev
```

- **`SUPERSET_WORKSPACE_NAME=superset` は必須**。未指定だと dev 環境のワークスペースデータが意図せず消える。
- dev 起動時に `bun run predev` で `scripts/patch-dev-protocol.ts` が走り、プロトコルハンドラをパッチ。

### ローカルでの配布ビルド確認

```bash
cd apps/desktop

# 1. コンパイル (electron-vite build)
bun run compile:app

# 2. ネイティブモジュール複製 + ランタイム検証
bun run copy:native-modules
bun run validate:native-runtime

# 3. electron-builder でパッケージ (配布物の dmg / zip を生成、未 publish)
bun run build
# または package のみ (publish 条件を無視)
bun run package
```

`bun run build` は `--publish never` で実行され、`apps/desktop/dist/` に成果物が出る。CI と同じ電池ない確認が可能。

### リリース (本番タグ)

GitHub Actions の `.github/workflows/release-desktop.yml` が `desktop-v*.*.*` タグ push でトリガーされる。手順:

```bash
# main 最新化
git checkout main && git pull

# 新バージョンで apps/desktop/package.json の version 更新
# 例: 1.5.7 → 1.5.8
# (手動編集 → commit → push → PR → merge)

# main にマージ後、タグ打ち
git tag desktop-v1.5.8
git push origin desktop-v1.5.8
```

タグを push すると:
1. `build-desktop.yml` 経由で macOS (arm64 / x64) / Windows / Linux ビルド
2. `release-desktop.yml` が GitHub Release を自動作成し artifact を添付
3. `bump-homebrew.yml` が Homebrew tap を更新 (必要に応じて)

**Canary リリース** は `.github/workflows/release-desktop-canary.yml` で別管理。Canary 用タグ命名規則はワークフロー参照。

### ビルド前チェックリスト — 忘れずに

dependency bump や upstream 取り込み後にリリースビルドを走らせる前、以下を必ず実施:

```bash
# lockfile と node_modules の整合性を取り直す (重複残骸を除去)
rm -rf node_modules apps/*/node_modules packages/*/node_modules
bun install
```

**理由:** `bun install` を override 切替や複数回 install で繰り返すと、lockfile には 1 バージョンしか無いのに node_modules 内に旧バージョンの残骸が残ることがある。この状態でビルドすると配布版に重複パッケージが混入し、`@pierre/diffs` 等の Web Components が `customElements.define` で二重登録され、DiffViewer のセパレータ枠線が白くなる等の UI 崩壊を引き起こす (参考: PR #332 / #333)。

以下のタイミングでは毎回上記のフルクリーンを挟むこと:
- dependency bump を含む PR を main にマージした直後
- `overrides` や `patchedDependencies` を変更した後
- `desktop-v*` タグを切る直前
- `release-desktop.yml` を手動トリガーする前

CI 側でもワークフロー実行前に `node_modules` を毎回ゼロから作っていれば問題ないが、ローカル確認時は特に注意。

## Code Quality

**Biome runs at root level** (not per-package) for speed:
- `biome check --write --unsafe` = format + lint + organize imports + fix all auto-fixable issues
- `biome check` = check only (no changes)
- `biome format` = format only
- Use `bun run lint:fix` to fix all issues automatically

## Agent Rules
1. **Type safety** - avoid `any` unless necessary
2. **Prefer `gh` CLI** - when performing git operations (PRs, issues, checkout, etc.), prefer the GitHub CLI (`gh`) over raw `git` commands where possible
3. **Shared command source** - keep command definitions in `.agents/commands/` only. `.claude/commands` and `.cursor/commands` should be symlinks to `../.agents/commands`. (`packages/chat` discovers slash commands from `.claude/commands`.)
4. **Workspace MCP config** - keep shared MCP servers in `.mcp.json`; `.cursor/mcp.json` should link to `../.mcp.json`. Codex uses `.codex/config.toml` (run with `CODEX_HOME=.codex codex ...`). OpenCode uses `opencode.json` and should mirror the same MCP set using OpenCode's `remote`/`local` schema.
5. **Mastra dependencies** - use the published upstream `mastracode` and `@mastra/*` packages. Do not add fork tarball overrides or custom patch steps unless explicitly requested.
6. **Package age security policy** - global `npm`, `bun`, `pnpm`, and `uv` configs enforce a 7-day minimum release age, and `npm` also has `ignore-scripts=true`. If package install/update/add commands fail because a version is too new or a lifecycle script is blocked, do not keep retrying, disable the policy, or suggest bypass flags. Choose an older version that satisfies the policy, or stop and surface the blocked dependency clearly.
7. **Plan & doc placement** - implementation plans go in `plans/` (cross-cutting) or `apps/<app>/plans/` (app-scoped); shipped plans move to `plans/done/`. Architecture/reference docs go in `<app>/docs/`. Never drop `*_PLAN.md` at an app root or inside `src/`.


---

## Project Structure

All projects in this repo should be structured like this:

```
app/
├── page.tsx
├── dashboard/
│   ├── page.tsx
│   ├── components/
│   │   └── MetricsChart/
│   │       ├── MetricsChart.tsx
│   │       ├── MetricsChart.test.tsx      # Tests co-located
│   │       ├── index.ts
│   │       └── constants.ts
│   ├── hooks/                             # Hooks used only in dashboard
│   │   └── useMetrics/
│   │       ├── useMetrics.ts
│   │       ├── useMetrics.test.ts
│   │       └── index.ts
│   ├── utils/                             # Utils used only in dashboard
│   │   └── formatData/
│   │       ├── formatData.ts
│   │       ├── formatData.test.ts
│   │       └── index.ts
│   ├── stores/                            # Stores used only in dashboard
│   │   └── dashboardStore/
│   │       ├── dashboardStore.ts
│   │       └── index.ts
│   └── providers/                         # Providers for dashboard context
│       └── DashboardProvider/
│           ├── DashboardProvider.tsx
│           └── index.ts
└── components/
    ├── Sidebar/
    │   ├── Sidebar.tsx
    │   ├── Sidebar.test.tsx               # Tests co-located
    │   ├── index.ts
    │   ├── components/                    # Used 2+ times IN Sidebar
    │   │   └── SidebarButton/             # Shared by SidebarNav + SidebarFooter
    │   │       ├── SidebarButton.tsx
    │   │       ├── SidebarButton.test.tsx
    │   │       └── index.ts
    │   ├── SidebarNav/
    │   │   ├── SidebarNav.tsx
    │   │   └── index.ts
    │   └── SidebarFooter/
    │       ├── SidebarFooter.tsx
    │       └── index.ts
    └── HeroSection/
        ├── HeroSection.tsx
        ├── HeroSection.test.tsx           # Tests co-located
        ├── index.ts
        └── components/                    # Used ONLY by HeroSection
            └── HeroCanvas/
                ├── HeroCanvas.tsx
                ├── HeroCanvas.test.tsx
                ├── HeroCanvas.stories.tsx
                ├── index.ts
                └── config.ts

components/                                # Used in 2+ pages (last resort)
└── Header/
```

1. **One folder per component**: `ComponentName/ComponentName.tsx` + `index.ts` for barrel export
2. **Co-locate by usage**: If used once, nest under parent's `components/`. If used 2+ times, promote to **highest shared parent's** `components/` (or `components/` as last resort)
3. **One component per file**: No multi-component files
4. **Co-locate dependencies**: Utils, hooks, constants, config, tests, stories live next to the file using them

### Exception: shadcn/ui Components

The `src/components/ui/` and `src/components/ai-elements` directories contain shadcn/ui components. These use **kebab-case single files** (e.g., `button.tsx`, `base-node.tsx`) instead of the folder structure above. This is intentional—shadcn CLI expects this format for updates via `bunx shadcn@latest add`.

## Database Rules

** IMPORTANT ** - Never touch the production database unless explicitly asked to. Even then, confirm with the user first.

- Schema in `packages/db/src/`
- Use Drizzle ORM for all database operations

## DB migrations
- Always spin up a new neon branch to create migrations. Update our root .env files to point at the neon branch locally.
- Use drizzle to manage the migration. You can see the schema at packages/db/src/schema. Never run a migration yourself.
- Create migrations by changing drizzle schema then running `bunx drizzle-kit generate --name="<sample_name_snake_case>"`
- `NEON_ORG_ID` and `NEON_PROJECT_ID` env vars are set in .env
- list_projects tool requires org_id passed in
- **NEVER manually edit files in `packages/db/drizzle/`** - this includes `.sql` migration files, `meta/_journal.json`, and snapshot files. These are auto-generated by Drizzle. If you need to create a migration, only modify the schema files in `packages/db/src/schema/` and ask the user to run `drizzle-kit generate`.
