# 2026-04-24 upstream 取り込み戦略 PR #2〜#6

## 1. Executive Summary

### 調査前提

- 調査基準: `origin/main..upstream/main`、`upstream` は `superset-sh/superset`、`origin` は `MocA-Love/superset`。
- 正確な生出力は `rtk proxy git log origin/main..upstream/main --no-merges --reverse --format="%H%x09%ai%x09%s"` で確認した。
- 注意: `rtk git log` 通常モードはログを圧縮するため 50 行に見えるが、`rtk proxy` の生出力では non-merge commit は 82 件だった。`git cherry origin/main upstream/main` では `+` が 67 件、`-` が 15 件。
- この計画書は、重複取り込みを避けるため `git cherry` の `-` 15 件も `already-merged` として表に残し、現 refs で見えている 82 件を全件分類する。

### 82 件の概観

- `already-merged`: 15 件。patch-id 一致のため取り込み禁止。PR #388 で実質取り込み済みのものを含む。
- `safe-feature`: 39 件。v2 UI、marketing、automations、CI/API/docs、細かな desktop UX が中心。ただし `automations`、`v2 project settings`、`v1 to v2 migration` はファイル数・DB 変更が大きく、ラベルは safe-feature でも PR サイズ上は高リスク。
- `host-service-batch`: 8 件。`packages/host-service`、host-service coordinator、v2 workspace git correctness、CLI/TRPC 組織 override、host-service DB clone が中心。PR #388 の `listBranches sortOrder/pinDefault` silent regression の再発領域。
- `terminal-critical`: 10 件。`session.ts`、port scanner、terminal paste/Unicode/font、terminal link/openExternal、TERM_PROGRAM など。fork の `TERMINAL_OPTIONS`、terminalId 移行、Windows 分岐と衝突しやすい。
- `version-bump`: 9 件。desktop version bump、host-service min version、dependency bump、auto-updater UI。fork の手動 release 運用と衝突しやすいため最後。
- `arch-rework`: 1 件。#3295。fork の 19 tRPC プロシージャと GitHub helper/cache 依存を壊すため単独 cherry-pick 禁止。
- `skip-permanent`: 0 件。現時点で恒久スキップにすべき upstream commit はない。ただし #3295 は「skip」ではなく、再設計 PR として扱う。

### 全体スケジュール

現 refs の `+` は 67 件あり、PR #388 の教訓である「PR あたり 8〜12 commits」を厳守すると 5 PR には収まらない。したがって、PR #2〜#6 は以下の順で進めるが、PR #2 と PR #6 は実作業時に sub-batch へ分割する判断を残す。

| PR | 主題 | 推奨 commit 数 | 推定工数 | 順序理由 |
| --- | --- | ---: | --- | --- |
| PR #2 | 新機能・低リスク UI/marketing/小粒 desktop | 10〜12 | 0.5〜1.5 日 | fork critical 領域から遠いものを先に減らす |
| PR #3 | host-service 系 | 8〜10 | 1〜2 日 | #3543 / listBranches 周辺を単独で監視する |
| PR #4 | terminal 系 | 8〜11 | 1〜2 日 | terminalId、TERMINAL_OPTIONS、Windows port scanner を集中確認する |
| PR #5 | #3295 + 19 tRPC プロシージャ再設計 | 1 upstream commit + fork refactor | 2〜4 日 | 大削除と fork GitHub 機能の両立を設計する |
| PR #6 | auto-updater / version bump / release 危険領域 | 6〜9 | 0.5〜1 日 | fork release 運用、version、build 成果物に影響するため最後 |

## 2. 各 commit の詳細分類

| SHA | Title | PR # | 分類 | fork 衝突リスク | silent regression 予測 | 依存 commit |
| --- | --- | --- | --- | --- | --- | --- |
| bb657ec463ec | fix(desktop): use --no-track instead of ^{commit} in v1 createWorktree | #3548 | host-service-batch | 中: v1 worktree 作成 utils | `SUPERSET_WORKSPACE_NAME` / worktree env の副作用 | なし |
| 92b6701ce8e9 | fix(desktop): guard installUpdate against repeat clicks on macOS | #3549 | version-bump | 高: auto-updater は fork release 運用に直結 | `installUpdate` pending state が fork の UpdateToast を上書き | PR #6 で 872361c と同時 |
| 5e8fc2d49e4e | fix(desktop): refresh v2 terminal link tooltip editor + nudge plain clicks | #3552 | terminal-critical | 中: terminal link UX | external editor / terminal click policy の fork 差分消失 | PR #4 |
| 4ba837862781 | fix(desktop): trigger macOS Local Network permission on startup | #3551 | safe-feature | 低: `main/index.ts` 2 行 | startup side effect が fork 初期化順序を変える可能性 | なし |
| 88e4e01d426c | feat(desktop): restore Tasks link in v2 dashboard sidebar | #3553 | safe-feature | 低: v2 sidebar header | fork の sidebar link / Kimi tab への影響は薄い | なし |
| c8f34d874828 | fix(desktop): unblock v1 terminal user input during shell init | #3550 | terminal-critical | 高: `terminal-host/session.ts` | fork terminalId 移行・shell-ready 判定を無音で戻す | PR #4 |
| aa23ae3b1850 | fix(desktop): stop excessive lsof spawning from port scanner | #3547 | terminal-critical | 高: `port-manager.ts` / `port-scanner.ts` | Windows 分岐、wmic/PowerShell fallback の消失 | PR #4、PR #388 の Windows 復元を再確認 |
| 33848baf324f | security: bump drizzle-orm and better-auth to patch CVEs | #3560 | version-bump | 中: package/bun.lock 全体 | fork 固有依存 `ansi_up`, `@vscode/ripgrep`, `@xyflow/react` が落ちる | PR #6 |
| 316d6f9a62e6 | chore(desktop): bump version to 1.5.6 | #3555 | version-bump | 高: fork は `v<version>-fork.N` 運用 | fork version / release notes の前提ズレ | PR #6、後続 version bump とまとめる |
| 872361c3dc97 | fix(desktop): show spinner on install update button while pending | #3561 | version-bump | 高: auto-updater UI | fork の UpdateToast / release channel 表示を上書き | 92b6701 と同時 |
| 1bf690b5a7e6 | fix(desktop): prevent keyboard shortcuts from leaking characters into chat input | #3520 | safe-feature | 中: hotkey registry / chat input | `BROWSER_RELOAD` / `BROWSER_HARD_RELOAD` の発火条件変化 | 14370d9 と同時確認 |
| 14370d929b74 | feat(desktop): Cmd+Shift+L opens diff viewer in v2 workspace | #3556 | safe-feature | 中: hotkey 重複再発領域 | V1 `TOGGLE_EXPAND_SIDEBAR` と V2 `OPEN_DIFF_VIEWER` の再衝突 | 1bf690b と同時確認 |
| 56e6652ef91b | fix(desktop): recover terminal from non-monospace font crash | #3554 | terminal-critical | 高: Terminal.tsx 周辺 | fork `TERMINAL_OPTIONS` 14 箇所の上書き | PR #4 |
| 37161ebd3f8a | fix(chat): cut display polling to 4fps and restore query cache defaults | #3562 | already-merged | なし | patch-id 一致。重複取り込み禁止 | 取り込み禁止 |
| db0cd2036c9b | polish(marketing): hero font, pixel-dithered demos, testimonials, CTA | #3563 | safe-feature | 中: marketing 独自差分があれば衝突 | fork の marketing copy/IA が upstream に戻る | PR #2 または別枠 |
| 99a1ca66fbb0 | Chat UX Enhancements | #3039 | safe-feature | 高: chat UI 広範囲 | fork の chat / tool call UI 差分が無音で消える | PR #2 sub-batch 推奨 |
| 9c40d2dacccf | fix(electric-proxy): re-enable Workers observability | #3565 | already-merged | なし | patch-id 一致。重複取り込み禁止 | 取り込み禁止 |
| 1b2fe39745f5 | docs: consolidated weekly changelog 2026-04-20 | #3564 | already-merged | なし | patch-id 一致。重複取り込み禁止 | 取り込み禁止 |
| 27e243b9b023 | fix: fall back to FETCH_HEAD when gh pr checkout fails for branch names with / | #3232 | already-merged | なし | patch-id 一致。重複取り込み禁止 | 取り込み禁止 |
| ae930dfd4e35 | feat(desktop): safer defaults for builtin terminal agent presets | #3546 | terminal-critical | 中: agent preset permissions | fork の agent preset / provider 設定が戻る | d19ba3d の backfill が後続 |
| 1f2c093558a8 | feat(v2): minimal project create/import for workspaces | #3566 | safe-feature | 高: v2 project/workspace 作成 | `SUPERSET_WORKSPACE_NAME`、workspace naming、v2 sidebar state | f85d6d8 / 9e3e073 の土台 |
| e2b9f42aa996 | feat(automations): scheduled agent runs (end-to-end) | #3576 | safe-feature | 高: 189 files、DB migration、API/CLI/TRPC | 手動 migration 事故、shared deps 残置判断、agent launch naming | 6e204ba / 5b38c8a と同時 |
| 444c9aacb56a | feat(chat): add Opus 4.7 model option | #3579 | already-merged | なし | patch-id 一致。重複取り込み禁止 | 取り込み禁止 |
| 1353b2083ce6 | fix(qstash): pin client to QSTASH_URL so region isn't picked by DNS | #3584 | safe-feature | 中: automations runtime | QSTASH env / region pin が fork env とズレる | e2b9f42 後 |
| 19c0d13b47b8 | fix(desktop): restore terminal buffer after Unicode 11 activation | #3581 | terminal-critical | 高: terminal lifecycle | fork の terminal buffer / pane guard が消える | PR #4 |
| b2278b1f7e3b | fix(desktop): terminal paste auto-submits first line without bracketed paste | #3582 | terminal-critical | 高: paste handler | `useTerminalLifecycle` と bracketed paste の fork 差分消失 | PR #4 |
| 487e43cb8fe7 | fix(desktop): dedupe DevicePicker in new-workspace modal | #3593 | safe-feature | 低: v2 new workspace modal | fork device/workspace picker copy が戻る | なし |
| 316d0869395e | fix(desktop): wire v2 sidebar project settings to settings route | #3592 | safe-feature | 中: settings route | fork settings route / project ID handlingの差分消失 | f85d6d8 と同時でも可 |
| bdd9a7ae80a8 | docs(readme): add caddy trust step to setup | #3595 | already-merged | なし | patch-id 一致。重複取り込み禁止 | 取り込み禁止 |
| 6e204ba49a5c | fix(automations): use _ and epoch ms in deduplicationId | #3591 | safe-feature | 中: automations queue | scheduled run dedupe 仕様のズレ | e2b9f42 後 |
| daf0e16214a6 | fix(relay): terminal WS URL prefix + pin to one fly machine | #3599 | already-merged | なし | patch-id 一致。重複取り込み禁止 | 取り込み禁止 |
| 4d32cf207e07 | fix(desktop): resolve GitHub status for branch workspaces | #3295 | arch-rework | 最高: 19 tRPC プロシージャの前提を削る | `git-status.ts` 2073→373 行、`github.ts` 866→413 行、`cache.ts` 393→141 行相当の大削除 | PR #5 専用 |
| 6f928882c194 | fix(desktop): wrap and truncate long workspace names in v1 hover card | #3603 | safe-feature | 低: v1 hover card | fork の sidebar item 表示差分 | なし |
| e964940e9d2b | fix(desktop): stop spurious folder picker on settings to dashboard nav | #3602 | safe-feature | 低: navigation side effect | fork の folder picker guard が戻る | なし |
| ae6cf143c328 | fix(desktop): unblock AI branch/workspace naming for OAuth-only users + dev placeholders | #3580 | safe-feature | 高: workspace naming | fork `SUPERSET_WORKSPACE_NAME` / AI naming / auth provider 差分 | 1f2c093 / e2b9f42 周辺 |
| d19ba3d8d2ad | fix(desktop): backfill legacy permissions for canary users exposed to #3546 | #3615 | terminal-critical | 中: agent preset permissions migration | drizzle/local-db migration 手順ミス、preset permission 上書き | ae930df 後 |
| 605c2ee496a1 | fix(host-service): v2 workspace git correctness | #3543 | host-service-batch | 高: `git.ts` / git helpers | `listBranches sortOrder/pinDefault` がまた消える | PR #3 専用寄り |
| 1e2302f1bbdd | feat(desktop): infer project name from folder on import | #3605 | safe-feature | 中: import flow | fork の new workspace modal / folder-first flow 差分 | 1f2c093 後が自然 |
| f175be48286d | fix(desktop): don't nuke host services on app update | #3620 | host-service-batch | 高: host-service coordinator | app update 時の fork host-service 永続化が戻る | ce065f と同時確認 |
| ce065f331d41 | refactor(desktop): host-service detach, rotation, perms, windowsHide, dev pipes | #3616 | host-service-batch | 高: coordinator / dev pipes | Windows hide、permission rotation、dev host pipes の fork 差分消失 | f175be と同時 |
| 62e1a77ecc8e | fix(desktop): hide v2 workspace rows while destroy is in flight | #3621 | safe-feature | 高: layout と sidebar provider | `MainWindowEffects` tearoff guard の再消失 | PR #2 ではなく危険枠推奨 |
| f85d6d84202e | feat(desktop): v2 project settings with setup/relocate path | #3606 | safe-feature | 高: 26 files、project route/TRPC | settings route、project path、setup script 周辺の fork 差分消失 | 1f2c093 / 316d086 後 |
| 0358690b311b | fix(desktop): spread dev dock-icon colors across full hue range | #3622 | safe-feature | 低: dock icon only | fork branding があれば上書き | なし |
| 9e3e07363349 | feat(desktop): route non-setup projects to settings from new workspace modal | #3626 | safe-feature | 中: new workspace modal | fork の project setup 判定が戻る | f85d6d8 後 |
| 9e8b08c39278 | test(desktop): remove flaky git-status.test.ts that leaks mocks across files | #3624 | safe-feature | 中: fork GitHub tests | fork 19 procedure のテスト保護が薄くなる | #3295 PR では扱い注意 |
| 14568920534b | fix(desktop): make v2 new-workspace project dropdown scrollable | #3628 | safe-feature | 低: UI only | fork styling 差分 | なし |
| 1195a4844e1e | fix(desktop): tray shows correct org name for each host-service | #3629 | already-merged | なし | patch-id 一致。重複取り込み禁止 | 取り込み禁止 |
| 3fc7027b62da | chore(ci): pin third-party GitHub Actions to commit SHAs | #3631 | safe-feature | 低: CI only | fork workflows の runner 前提差分 | なし |
| a2a7ba50d05b | feat(desktop): add Copy Branch Name to v1 and v2 sidebar context menus | #3635 | safe-feature | 中: sidebar workspace item | `listBranches`、branch prop、context menu の fork 差分 | 605c2ee 後が安全 |
| 6a2c4dd965ab | chore(ci): drop Fly.io Electric deploys | #3590 | safe-feature | 中: deploy workflow | fork が Fly.io を使っていないか確認 | なし |
| 5b38c8a57fb2 | chore(automations): post-qstash-ship cleanup | #3583 | safe-feature | 中: automations cleanup | QStash env / shared deps の整理が fork とズレる | e2b9f42 / 1353b20 後 |
| 2c6d6ebc14d8 | fix(desktop): new v2 workspaces appear at top of their project in sidebar | #3619 | already-merged | なし | patch-id 一致。重複取り込み禁止 | 取り込み禁止 |
| d006f60a0c82 | feat(desktop): configurable link-click behavior in v2 | #3600 | safe-feature | 高: terminal/file link click policy | fork の browser reload / external editor choice と衝突 | 5e8fc2 / ae5cd6 と同時確認 |
| 400989f4535e | docs(relay): hardening + horizontal scale-out plan | #3636 | already-merged | なし | patch-id 一致。重複取り込み禁止 | 取り込み禁止 |
| 5bc8b81ee5bf | chore(api): remove legacy Vercel electric proxy | #3637 | safe-feature | 中: API deploy | fork deploy path に legacy proxy が必要なら破壊 | 6a2c4dd と同時 |
| 45dd81c691b6 | feat(cli,trpc): organization override via header, no session mutation | #3638 | host-service-batch | 中: CLI/TRPC auth | fork auth/session mutation 前提が変わる | PR #3 |
| 38a080cf4682 | feat(marketing): add /pricing page and redesign header/footer IA | #3639 | safe-feature | 中: marketing IA | fork marketing site copy/route が upstream 化 | db0cd203 と同時 |
| a4e156786a71 | fix(cli): match host service PORT env var name in spawn | #3640 | already-merged | なし | patch-id 一致。重複取り込み禁止 | 取り込み禁止 |
| 6ae8ea96f01c | fix(host-service): stop misattributing cross-fork PRs to local workspaces | #3625 | host-service-batch | 高: GitHub PR identity | fork 19 GitHub procedure / PR identity candidates と衝突 | 605c2ee、#3295 設計と接点 |
| 5914bb9541bc | feat(desktop): v1 review comments open in a pane like v2 | #3596 | safe-feature | 高: review pane / GitHub comments | fork ReviewPanel の mutation/query 19 procedure 連携に影響 | #3295 方針確定後が安全 |
| 0fb5441b51c8 | feat(desktop): render mermaid diagrams in markdown pane | #3642 | already-merged | なし | patch-id 一致。重複取り込み禁止 | 取り込み禁止 |
| cfc9c270b970 | chore(desktop): bump version to 1.5.8 | #3617 | version-bump | 高: fork release version | `v1.5.5-fork.N` 系との整合性 | PR #6 |
| 52e9e757ea83 | feat(setup): clone v2 host-service DBs alongside v1 local DB | #3630 | host-service-batch | 高: setup scripts / host-service DB | local DB clone、dev seed、workspace migration の fork 差分 | PR #3 または #6 migration 枠 |
| b21a3b94b509 | handle local/remote/offline state on sidebar workspace icons | #3649 | already-merged | なし | patch-id 一致。重複取り込み禁止 | 取り込み禁止 |
| 1771c7286fce | fix(desktop): render pending workspaces at top of sidebar | #3655 | already-merged | なし | patch-id 一致。重複取り込み禁止 | 取り込み禁止 |
| 0169f1430a66 | fix(desktop): allowlist URL schemes before shell.openExternal | #3650 | terminal-critical | 中: external URL security | fork `browser-manager.ts` safeOpenExternal 差分との二重化/消失 | 57aa28 は既取り込み |
| 6764f171657c | feat(desktop): keypad + scrolling steps for workspace setup loader | #3647 | safe-feature | 中: setup loader UI | fork setup script wording / SUPERSET_WORKSPACE_NAME 表示 | 1f2c093 / f85d6d8 後 |
| e49600fdebe2 | fix(desktop): persist v2 sidebar open state globally across workspaces | #3656 | safe-feature | 中: local state | fork dashboardSidebarLocal schema 差分 | 81eaff6 と同時確認 |
| 57aa28c84f4d | fix(desktop): unbreak safe-url test on bun by splitting pure helpers | #3659 | already-merged | なし | patch-id 一致。重複取り込み禁止 | 取り込み禁止 |
| de7a42f94161 | feat(desktop): redesign v2-workspaces as a sortable table | #3660 | safe-feature | 中: v2 workspaces list | fork sidebar/workspace order と表示差分 | 2c6d6eb / 1771c72 は既取り込み |
| dfa14bfe50a4 | chore(desktop): bump version to 1.5.9 | #3658 | version-bump | 高: fork release version | version history が upstream 化 | PR #6 |
| 5501bae43826 | feat(host-service): restore AI workspace naming on v2 create | #3654 | host-service-batch | 中: host-service workspace naming | fork `SUPERSET_WORKSPACE_NAME` / AI naming 差分 | 605c2ee / ae6cf14 後 |
| 0bc1d0a0eb62 | fix(desktop): toast and switch workspace when deleting in v2 | #3661 | safe-feature | 中: delete flow | fork cleanupMissingWorktrees / destroy dialog behavior | 62e1a77 / 81eaff6 と同時 |
| b804ae3af202 | feat(desktop): port v1 projects + workspaces into v2 | #3670 | safe-feature | 高: local-db migration、workspace creation | drizzle journal prefix、v1/v2 migration state、SUPERSET workspace path | PR #6 か専用 PR 推奨 |
| 5b8cd2435637 | chore(host-service): bump version to 0.2.0 + raise min version | #3672 | version-bump | 高: host-service min version | fork packaged host-service と min version 不一致 | PR #6、host-service PR 後 |
| 0791b0b042e5 | chore(desktop): bump version to 1.5.10 | #3673 | version-bump | 高: fork release version | upstream version が fork release に混入 | PR #6 最後 |
| ae5cd60bc2fa | fix(desktop): v2 file-open honors CMD+O editor choice | #3674 | safe-feature | 高: external editor / file open | fork `TERMINAL_OPTIONS` / OpenInExternalDropdown の terminal option 消失 | d006f60 と同時 |
| 4a1af2ea8af3 | fix(desktop): use task title as workspace name when opening a task | #3678 | safe-feature | 低: task open naming | fork workspace naming convention と軽微衝突 | なし |
| 7970e64367d0 | fix(desktop): claim TERM_PROGRAM=kitty so TUIs parse Shift+Enter CSI-u | #3667 | terminal-critical | 中: host-service terminal env | fork terminal env / SUPERSET_WORKSPACE_NAME の env filter と衝突 | PR #4 |
| 64a36f051b19 | chore(deps): bump uuid from ^13.0.0 to ^14.0.0 | #3680 | version-bump | 中: package/bun.lock | fork dependency lock 差分、minimum package age policy | PR #6 |
| 81eaff6e7399 | fix(desktop): persist also delete local branch checkbox in v2 delete dialog | #3681 | safe-feature | 中: cleanup/destroy prefs | fork cleanupMissingWorktrees、dashboardSidebarLocal schema と衝突 | 0bc1d0a と同時 |
| 8b3ff231a4fa | feat(desktop): v2 Changes file list shift/cmd-click policy | #3683 | safe-feature | 中: ChangesView file selection | fork ReviewPanel/RepositoryPanel/ChangesView 差分 | ae5cd60 / d006f60 後 |

## 3. PR 構成提案

### PR #2 — 新機能系・低リスク

推奨対象 SHA:

`4ba837862781`, `88e4e01d426c`, `db0cd2036c9b`, `487e43cb8fe7`, `316d0869395e`, `6f928882c194`, `e964940e9d2b`, `1e2302f1bbdd`, `0358690b311b`, `14568920534b`, `3fc7027b62da`, `38a080cf4682`

Scope 理由:

- fork critical である GitHub 19 procedure、terminal session、host-service coordinator、auto-updater、version bump を避ける。
- v2 sidebar/header、new workspace modal の小粒修正、marketing/CI の独立差分を先に消す。
- 12 commits で推奨上限ぎりぎり。`99a1ca66`, `1f2c093`, `f85d6d8`, `b804ae3` は大きすぎるため PR #2 に入れない。

予想される衝突点:

- `apps/marketing` の header/footer/hero copy。
- `DashboardSidebarHeader.tsx`、new workspace modal 周辺。
- `.github/workflows` は self-hosted runner / fork workflow 差分を確認。

silent regression 検証ファイル:

- `apps/desktop/src/renderer/routes/_authenticated/_dashboard/components/DashboardSidebar/components/DashboardSidebarHeader/DashboardSidebarHeader.tsx`
- `apps/desktop/src/renderer/routes/_authenticated/_dashboard/components/DashboardNewWorkspaceForm/`
- `apps/desktop/src/renderer/routes/_authenticated/settings/`
- `.github/workflows/*`
- `apps/marketing/**/*`

推定工数: 0.5〜1.5 日。

### PR #3 — host-service 系

推奨対象 SHA:

`bb657ec463ec`, `605c2ee496a1`, `f175be48286d`, `ce065f331d41`, `45dd81c691b6`, `6ae8ea96f01c`, `52e9e757ea83`, `5501bae43826`, `5b8cd2435637`

Scope 理由:

- `packages/host-service` と host-service coordinator をまとめ、`listBranches sortOrder/pinDefault` の silent regression をこの PR だけで追えるようにする。
- #3543 は PR #388 で silent regression を起こした既知危険領域なので、他の UI 変更と混ぜない。
- `5b8cd243` は version-bump 性質もあるが host-service min version と一体なので、PR #3 で実装して PR #6 で release version と再確認する案がよい。

予想される衝突点:

- `packages/host-service/src/trpc/router/git/git.ts`
- `packages/host-service/src/trpc/router/git/utils/git-helpers.ts`
- `packages/host-service/src/workspace-creation/workspace-creation.ts`
- `apps/desktop/src/main/lib/host-service-coordinator.ts`
- `.superset/lib/setup/steps.sh`

silent regression 検証ファイル:

- `packages/host-service/src/trpc/router/git/git.ts`: `sortOrder`, `pinDefault`, remote-only branch、default branch pinning。
- `apps/desktop/src/renderer/routes/_authenticated/settings/git/components/GitSettings/GitSettings.tsx`
- `apps/desktop/src/lib/trpc/routers/settings/index.ts`
- `apps/desktop/src/shared/worktree-id.ts`
- `apps/desktop/src/main/lib/host-service-coordinator.ts`
- `packages/host-service/src/terminal/env.ts`

推定工数: 1〜2 日。

### PR #4 — terminal 系

推奨対象 SHA:

`5e8fc2d49e4e`, `c8f34d874828`, `aa23ae3b1850`, `ae930dfd4e35`, `d19ba3d8d2ad`, `56e6652ef91b`, `19c0d13b47b8`, `b2278b1f7e3b`, `0169f1430a66`, `7970e64367d0`, `ae5cd60bc2fa`

Scope 理由:

- terminal session、port scanner、paste、Unicode 11、font fallback、external link/file-open、TERM_PROGRAM を一括で扱う。
- fork の terminalId 移行、`TERMINAL_OPTIONS`、Windows port scanner 復元、VS Code shim / external editor 周辺を同時に silent diff 確認する。

予想される衝突点:

- `apps/desktop/src/main/terminal-host/session.ts`
- `apps/desktop/src/main/lib/terminal/port-scanner.ts`
- `apps/desktop/src/main/lib/terminal/port-manager.ts`
- `apps/desktop/src/renderer/screens/main/components/WorkspaceView/ContentView/TabsContent/Terminal/Terminal.tsx`
- `apps/desktop/src/renderer/screens/main/components/WorkspaceView/ContentView/TabsContent/Terminal/helpers.ts`
- `apps/desktop/src/renderer/components/OpenInExternalDropdown/*`
- `packages/host-service/src/terminal/env.ts`

silent regression 検証ファイル:

- `apps/desktop/src/renderer/screens/main/components/WorkspaceView/ContentView/TabsContent/Terminal/config.ts`
- `apps/desktop/src/renderer/screens/main/components/WorkspaceView/ContentView/TabsContent/Terminal/Terminal.tsx`
- `apps/desktop/src/main/lib/terminal/port-scanner.ts`: `win32`, `wmic`, PowerShell fallback。
- `apps/desktop/src/main/lib/browser/browser-manager.ts`: `safeOpenExternal` と URL allowlist。
- `apps/desktop/src/renderer/components/OpenInExternalDropdown/constants.ts`: `TERMINAL_OPTIONS`。
- `apps/desktop/src/renderer/screens/main/components/VscodeExtensionButtons/VscodeExtensionButtons.tsx`

推定工数: 1〜2 日。

### PR #5 — #3295 + fork 19 プロシージャ再設計

推奨対象 SHA:

`4d32cf207e07`

この PR は cherry-pick ではなく再設計 PR として扱う。`origin/main` と `upstream/main` の比較では、対象 3 ファイルが概ね以下の規模で縮む。

- `git-status.ts`: 2073 行 → 373 行。
- `github.ts`: 866 行 → 413 行。
- `cache.ts`: 393 行 → 141 行。

fork の 19 tRPC プロシージャは `git-status.ts` と `utils/github/*` に強く依存しているため、#3295 の upstream 簡素化をそのまま入れると RepositoryPanel / ReviewPanel / ActionLogsPane / ProjectWorktreeAutoSync が破綻する。

#### 再設計案 A: fork GitHub 機能を dedicated router に分離

- `apps/desktop/src/lib/trpc/routers/workspaces/procedures/git-status.ts` は upstream 形に近づける。
- 19 procedure を `workspaces/github-extended.ts` のような専用 router に分離し、RepositoryPanel / ReviewPanel は新 router を参照する。
- `utils/github/github.ts` と `cache.ts` は fork 専用 helper として残し、upstream の軽量 git-status helper とは依存方向を分ける。

トレードオフ:

- 長所: 今後 upstream の `git-status.ts` 追従が楽になる。#3295 の狙いである status 軽量化を受け入れやすい。
- 短所: renderer 側の query/mutation import と invalidation key が広範囲に変わる。型生成・TRPC 呼び出しの追従が必要。

#### 再設計案 B: upstream lightweight status を fork 既存 router 内に adapter として取り込む

- `git-status.ts` の既存 19 procedure は維持。
- upstream #3295 の branch-workspace status 解決だけを `getWorkspaceGitStatusLite` のような内部関数へ抽出し、既存 procedure の一部から呼ぶ。
- `github.ts` / `cache.ts` の大削除は受け入れず、必要な helper export を残す。

トレードオフ:

- 長所: UI 側の変更が少なく、fork 19 procedure の regression リスクが低い。
- 短所: upstream との差分は大きいまま残る。今後も `git-status.ts` で conflict が出やすい。

#### 再設計案 C: helper/cache を package 境界へ移し、desktop router は facade 化

- GitHub API helper、cache、identity candidate、workflow log 取得を `packages/shared` か desktop 内 dedicated service に移す。
- `git-status.ts` は facade と schema 定義だけに寄せる。

トレードオフ:

- 長所: テストしやすく、#3295 と fork 拡張の責務境界が最も明確。
- 短所: 工数が最大。PR #5 単体で 2〜4 日を超える可能性がある。

推奨: 案 A。fork 19 procedure を専用 router に逃がすと、upstream の git-status 簡素化と fork の GitHub 拡張を同時に保てる。短期安定を優先するなら案 B。

silent regression 検証ファイル:

- `apps/desktop/src/lib/trpc/routers/workspaces/procedures/git-status.ts`
- `apps/desktop/src/lib/trpc/routers/workspaces/utils/github/github.ts`
- `apps/desktop/src/lib/trpc/routers/workspaces/utils/github/cache.ts`
- `apps/desktop/src/renderer/screens/main/components/WorkspaceView/RightSidebar/ChangesView/components/RepositoryPanel/RepositoryPanel.tsx`
- `apps/desktop/src/renderer/screens/main/components/WorkspaceView/RightSidebar/ChangesView/components/ReviewPanel/ReviewPanel.tsx`
- `apps/desktop/src/renderer/screens/main/components/WorkspaceView/ContentView/TabsContent/TabView/ActionLogsPane/ActionLogsPane.tsx`
- `apps/desktop/src/renderer/routes/_authenticated/_dashboard/project/$projectId/components/ProjectWorktreeAutoSync/ProjectWorktreeAutoSync.tsx`

推定工数: 2〜4 日。

### PR #6 — fork 危険領域（auto-updater / version bump）

推奨対象 SHA:

`92b6701ce8e9`, `33848baf324f`, `316d6f9a62e6`, `872361c3dc97`, `cfc9c270b970`, `dfa14bfe50a4`, `0791b0b042e5`, `64a36f051b19`

Scope 理由:

- fork は `release-desktop.yml` を使わず、`v<package.json version>-fork.N` タグと `gh release create` による手動 release 運用。
- upstream version bump を早く入れると、以後の取り込み PR で package version と release notes の判断が濁る。
- auto-updater は配布版の動線に直結するため、host-service / terminal / #3295 の functional risk を片付けた最後に扱う。

予想される衝突点:

- `apps/desktop/package.json`
- `bun.lock`
- `apps/desktop/src/main/lib/auto-updater.ts`
- `apps/desktop/src/main/lib/auto-updater.test.ts`
- UpdateToast / install update button 周辺
- `apps/desktop/electron-builder.ts`

silent regression 検証ファイル:

- `apps/desktop/electron-builder.ts`: `dmg.size = "4g"` が残っていること。
- `apps/desktop/package.json`: fork が upstream version と fork tag 運用をどう扱うか確認。
- root `package.json` / `bun.lock`: `ansi_up`, `@vscode/ripgrep`, `@xyflow/react` が残ること。
- `apps/desktop/electron.vite.config.ts`: `SUPERSET_WORKSPACE_NAME` define が残ること。
- release notes / manual release 手順への影響。

推定工数: 0.5〜1 日。

### PR #2〜#6 に収まらない大物の扱い

現 refs では safe-feature に見えるが、以下は PR #2 に混ぜると 29 commits 再発に近づく。PR #2b / #6b などに分ける判断が必要。

- `99a1ca66fbb0` Chat UX Enhancements: chat UI 広範囲。
- `1f2c093558a8` v2 project create/import: 後続 v2 project settings の土台。
- `e2b9f42aa996` scheduled agent runs: 189 files、DB migration、API/CLI/TRPC/workflows。
- `f85d6d84202e` v2 project settings: 26 files、settings route と TRPC。
- `5914bb9541bc` v1 review comments pane: fork GitHub 19 procedure と接点。
- `b804ae3af202` v1 projects/workspaces into v2: local-db migration を含む。
- `d006f60a0c82`, `ae5cd60bc2fa`, `8b3ff231a4fa`: link/file-click policy と ChangesView 操作系。

## 4. 各 PR 共通チェックリスト

### 作業前

- `rtk proxy git cherry -v origin/main upstream/main` を保存し、`-` は絶対に cherry-pick 対象に入れない。
- 対象 SHA の `git show --stat <SHA>` を確認し、PR の対象ファイル一覧を作る。
- fork 固有機能の grep baseline を取る。
  - 19 tRPC procedure 名。
  - `ansi_up`, `@vscode/ripgrep`, `@xyflow/react`。
  - `dmg.size: "4g"`。
  - `SUPERSET_WORKSPACE_NAME`。
  - `moonshot-ai.kimi-code`。
  - `TERMINAL_OPTIONS`。
  - `sortOrder`, `pinDefault`。
  - `INCEPTION_AUTH_PROVIDER_ID`。
  - `MainWindowEffects` / tearoff guard。
  - `port-scanner.ts` の `win32`, `wmic`, PowerShell fallback。
  - `BROWSER_RELOAD`, `BROWSER_HARD_RELOAD`。
- DB migration を含む PR では、`packages/db/drizzle/` と `packages/local-db/drizzle/` を手で編集しない方針を PR 本文に明記する。

### 作業中

- conflict がなくても、対象 PR の fork 固有ファイルは `git diff origin/main...HEAD -- <file>` で silent diff を見る。
- upstream commit の大きい削除は、`git diff --stat origin/main upstream/main -- <file>` と `git show upstream/main:<file> | wc -l` で行数差を確認する。
- CodeRabbit/Codex bot の指摘は A/B/C/D に分類する。
  - A: fork 取り込み起因の真バグ。修正する。
  - B: 現 HEAD で解消済み。根拠 commit/行を示す。
  - C: upstream 機能そのものへの指摘。取り込み PR scope 外として扱う。
  - D: ユーザー判断。release、UX 方針、fork 固有仕様の判断を仰ぐ。
- migration が必要な場合は schema だけ変更し、`drizzle-kit generate` はユーザー実行または専用手順で行う。journal/SQL/snapshot は手編集しない。

### 作業後

- `git cherry origin/main upstream/main` を再実行し、取り込んだ SHA が patch-id `-` になったか確認する。
- fork 固有機能 grep を作業前 baseline と比較する。
- PR body に以下を必ず入れる。
  - 対象 upstream SHA 一覧。
  - 意図的に除外した SHA 一覧。
  - silent regression 検証ファイル。
  - fork 固有機能ヘルスチェック結果。
  - bot review A/B/C/D 分類結果。
- テストはユーザーが実行する前提。ただし PR 本文には推奨確認項目を列挙する。

## 5. 開始順序の推奨とリスク管理

1. PR #2 で低リスク UI/marketing/CI を処理する。ここで cherry-pick 手順、silent diff 手順、PR body テンプレートを固める。
2. PR #3 で host-service を処理する。#3543 の `listBranches sortOrder/pinDefault` は必ず手で確認する。
3. PR #4 で terminal を処理する。Windows port scanner と `TERMINAL_OPTIONS` は conflict 有無に関係なく確認する。
4. PR #5 で #3295 を設計実装する。ここは cherry-pick ではなく fork architecture PR として扱う。
5. PR #6 で auto-updater / version bump / dependency bump を処理する。release 手順への影響を最後にまとめて判断する。

リスク管理:

- 1 PR に 12 commits を超えて入れない。超える場合は PR #2b / #6b に分ける。
- `already-merged` は表から消さず、PR body に「除外: patch-id 既取り込み」として残す。
- #3295 は PR #5 まで絶対に混ぜない。
- `packages/db/drizzle/` と `packages/local-db/drizzle/` は手編集禁止。生成物の prefix/journal がズレたら、その PR で修正せず migration 手順からやり直す。
- conflict がないファイルほど silent regression を疑う。特に `git.ts`, `Terminal.tsx`, `port-scanner.ts`, `layout.tsx`, `electron-builder.ts`, `package.json`。

## 6. PR 作成後の Codex 最終確認で聞くべき観点

- この PR の対象 upstream SHA と `git cherry` の `+/-` は一致しているか。
- `already-merged` の SHA を誤って再取り込みしていないか。
- fork 19 tRPC procedure は全て残っているか。
- `RepositoryPanel`, `ReviewPanel`, `ActionLogsPane`, `ProjectWorktreeAutoSync` は参照先 procedure と schema が一致しているか。
- `listBranches` の `sortOrder` / `pinDefault` / default branch pinning は残っているか。
- `TERMINAL_OPTIONS` の import と適用箇所は残っているか。
- `port-scanner.ts` の Windows 分岐、wmic、PowerShell fallback は残っているか。
- `MainWindowEffects` は tearoff window で singleton effects を起動しないか。
- `SUPERSET_WORKSPACE_NAME` の build-time define、runtime env、worktree-id 正規化は残っているか。
- `dmg.size = "4g"` は残っているか。
- Kimi Code (`moonshot-ai.kimi-code`) の settings / shim / button / right sidebar は残っているか。
- `INCEPTION_AUTH_PROVIDER_ID` と chat auth provider の import は残っているか。
- `BROWSER_RELOAD` / `BROWSER_HARD_RELOAD` は v1/v2 workspace で残っているか。
- DB migration 生成物に手編集由来の journal prefix ズレはないか。
- CodeRabbit/Codex bot コメントは A/B/C/D に分類され、A だけ修正されているか。

## 7. 未解決の懸念・ユーザー判断が必要な事項

- 現 refs では raw commit 数が 82 件、未取り込み `+` が 67 件で、ユーザー前提の「残り 50 件」と差がある。作業前に `origin/main` / `upstream/main` の fetch 状態を確認し、正式な基準 ref を確定したい。
- PR #2〜#6 の 5 本だけで全 `+` 67 件を扱うと、PR #388 の反省である 8〜12 commits 上限を守れない。PR #2b / #6b の追加を許容するか判断が必要。
- marketing site の upstream redesign を fork に取り込むか。fork が app/desktop 配布中心なら後回しでもよい。
- `e2b9f42` automations と `b804ae3` v1→v2 migration は DB migration を含む。fork の配布タイミングに合わせて専用 PR に分けるか判断が必要。
- desktop version を upstream 1.5.10 まで上げるか、fork の `1.5.5-fork.N` 系を維持するか。release note / auto-updater 表示に影響する。
- #3295 は案 A を推奨するが、短期安定を優先して案 B にするか判断が必要。
