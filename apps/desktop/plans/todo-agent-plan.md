# TODO 自律エージェント 実装計画

フォーク内限定の機能。ワークスペースの `Run` ボタンの左側にボタンを追加し、
ユーザーが定義した目標が検証可能な形で達成されるまで、無人で実行を続ける
自律的な Claude Code ループを起動できるようにする。実行中のワーカー端末は
常にライブで可視化され、ユーザーは必要に応じて介入できる。

## 目的

- ユーザーは (1) 何をしてほしいか と (2) 明確なゴール
  （受け入れ判定コマンド）を入力するだけでよく、その後は追加の指示なしで
  システムが Claude Code を完了まで動かす。
- ライブ可視性: 実行中ワーカーは実際の PTY であり、既存の
  `TerminalPane` コンポーネントで描画されるため、誰でも監視したり
  直接入力したりできる。
- 信頼性: 完了判定は決定的な verify コマンドの終了コードで行い、
  LLM の自己申告には依存しない。
- 逐次実行: 同時にアクティブなのは 1 タスクのみとし、それ以外はキューに入れる。
- upstream とのマージ容易性: 新規コードはすべて新しいファイル / ディレクトリに
  置き、既存ファイルへの変更は追記のみ、かつ 1 行変更を 3 箇所に限定する。

## 非目的（v1）

- タスクの並列実行。
- Cloud / Modal 上のサンドボックス実行
  （ローカル worktree のみを対象とする）。
- セッションをまたいだ LLM 判定。最終判定はシェルの verify コマンドとする。
- PR の自動作成。（v2 で対応予定）

## アーキテクチャ

```
Renderer                                    Main process
────────                                    ────────────
TodoButton (PresetsBar)                     TodoSupervisor (singleton)
  └─ TodoModal ──► trpc todo.create ──────► createSession()
                                             ├─ writes .superset/todo/<id>/goal.md
                                             ├─ inserts DB row (queued)
                                             └─ returns sessionId
TodoPanel                                   enqueue / runQueue loop
  ├─ trpc todo.subscribeState ◄───────────  state observable (per session)
  ├─ embeds <TerminalPane paneId> ◄──────── (paneId assigned by renderer)
  ├─ Abort / Pause buttons                  ├─ spawnWorker(paneId) via
  └─ Intervene input ──► trpc todo.sendKey ─┘    existing terminal.write
                                             ├─ subscribe data:${paneId}
                                             │    (idle timer + log capture)
                                             ├─ runVerify() (child_process)
                                             └─ update state / next iteration
```

Supervisor は **メインプロセス上で動く純粋な TypeScript** であり、
2 つ目の Claude Code インスタンスではない。これが最も重要な単純化ポイントで、
LLM 間通信は存在せず、「管理」役は決定論的な TS コードで担い、
創造的な処理はすべてワーカー側に集約する。

## 実行ループ

各セッションは状態遷移ごとに DB へ永続化する:

```
queued → preparing → running → verifying → done
                      │           │
                      │           └──► running   (fail, under budget)
                      │                  │
                      │                  └──► escalated (futility)
                      └──► aborted
```

各イテレーションの流れ:

1. Supervisor はワーカー用 PTY ペインの存在を確認する
   （初回は renderer が `tabs.addTerminalPane` で作成し、
   `todo.attachPane` で `paneId` を登録する）。
2. `goal.md`、現在の `state.json`、およびリトライ時は verify 失敗ログの末尾を
   もとにプロンプトを組み立てる。
3. Supervisor はそのプロンプトを `terminal.write` 経由で PTY に書き込む。
   ワーカー側では、対話モードの `claude` が既にペイン内で待機している。
4. Supervisor は node-pty emitter の `data:${paneId}` イベントを購読する
   （メインプロセスから
   `getWorkspaceRuntimeRegistry().getDefault().terminal` で直接参照可能）。
   チャンクを受け取るたびに 5 秒のアイドルタイマーをリセットする。
5. ストリームがしきい値時間だけアイドル状態になり、かつ
   ターン完了ヒューリスティックを満たしたら、Supervisor は worktree 上で
   `verifyCommand` を独立した child process として実行し、
   終了コードとログ末尾を取得する。
6. `exit 0` の場合は状態を `done` にし、判定結果を記録して通知を送る。
7. 非 0 の場合は futile 判定
   （同じ failing test が N 回連続、または同じ diff が 2 回連続）を行い、
   次イテレーションへ進むか、`escalated` にするかを決める。
8. 状態が変わるたびに Supervisor は `sessionId` をキーにした
   `EventEmitter` へ通知し、それを trpc subscription 側が購読する。

### Stop hook ではなく idle 検知を使う理由

Stop hook の方がきれいだが、ワーカー起動コマンドへ
`--settings <custom path>` を差し込む必要があり、これはインストール済みの
Claude Code バイナリがそのフラグをサポートしているかに依存する。v1 では、
Claude Code CLI の内部仕様と結合しないように idle 検知を使う。
Stop hook 連携は v2 の拡張項目として、後述の `Unresolved` に記載する。

### 予算と futile ガード

- `maxIterations`（デフォルト 10）
- `maxWallClockSec`（デフォルト 1800）
- `maxTurnsPerIteration` は強制しない
  （対話モードのため）。wall-clock と iteration 上限を優先する。
- Futility: verify が同じテスト名で 3 イテレーション連続失敗する、
  あるいは worktree diff が前回イテレーションと完全一致する場合。
- 予算超過または futility 検知時は `escalated` とし、セッションは永続化しつつ、
  ワーカーペインはそのまま残してユーザーが引き継げるようにする。

## 介入 UX

- PTY は通常のターミナルなので、`TerminalPane` を開いているユーザーは
  直接入力できる。Supervisor が入力を専有することはない。
- `TodoPanel` でもワンクリックの `Send` 入力欄を提供し、
  ユーザーがターミナルにフォーカスを移さなくても
  `terminal.write({paneId, data})` を実行できるようにする。
- `Pause` ボタンはイテレーションスケジューラを停止するだけで、
  ワーカーの現在のターン自体は継続する。kill はしない。
- `Abort` は PTY に `Ctrl-C`（`\x03`）を 2 回送ったうえで、
  状態を `aborted` にする。

## UI サーフェス

- **`TodoButton`**: `PresetsBar.tsx:488` の `WorkspaceRunButton` 左に置く
  コンパクトなボタン。キュー中 + 実行中セッション数の小さなカウンターを表示する。
  クリックで `New TODO`、`Open panel`、最近のセッションを含むドロップダウンを開く。
- **`TodoModal`**: フォーム項目は以下。
  - タイトル（必須）
  - 説明（必須、複数行）
  - ゴール / 受け入れ条件（必須、複数行）
  - Verify コマンド（デフォルト: `bun test`）
  - 予算: 最大イテレーション数（デフォルト 10）、
    wall-clock 分数（デフォルト 30）
- **`TodoPanel`**: 右側ドロワー。左にセッション一覧、右に詳細。
  詳細にはゴール、フェーズ、イテレーション、残り予算、最新の判定結果、
  ワーカー用に埋め込まれた `<TerminalPane>`、および
  Pause / Abort / Send コントロールを表示する。

## フォーク衝突面

### 新規ファイル（衝突リスクなし）

```
apps/desktop/plans/todo-agent-plan.md                            (this file)
apps/desktop/src/main/todo-agent/
  index.ts                      barrel
  types.ts                      shared types + zod schemas
  supervisor.ts                 singleton loop driver
  session-store.ts              in-memory session map + EventEmitter fan-out
  worker-pty.ts                 thin wrapper around terminal.write / onData
  verify-runner.ts              child_process exec of verifyCommand
  futility-detector.ts          repeat-failure / diff-stall detection
  prompt-builder.ts             composes the claude prompt per iteration
  trpc-router.ts                tRPC router factory (createTodoAgentRouter)
packages/db/src/schema/todo-sessions.ts                          (new table)
apps/desktop/src/renderer/features/todo-agent/
  TodoButton/TodoButton.tsx
  TodoButton/index.ts
  TodoModal/TodoModal.tsx
  TodoModal/index.ts
  TodoPanel/TodoPanel.tsx
  TodoPanel/index.ts
  hooks/useTodoSession.ts
  hooks/useTodoQueue.ts
```

### 変更する既存ファイル（最小限、追記のみ）

1. `packages/db/src/schema/index.ts`
   1 行追加: `export * from "./todo-sessions";`
2. `apps/desktop/src/lib/trpc/routers/index.ts`
   import 1 行 + router object に 1 行追加:
   `todoAgent: createTodoAgentRouter()`.
3. `apps/desktop/src/renderer/screens/main/components/WorkspaceView/ContentView/components/PresetsBar/PresetsBar.tsx`
   既存の `<WorkspaceRunButton … />` 描画直前の 1 行
   （488 行目付近）に
   `<TodoButton workspaceId={workspaceId} projectId={projectId} worktreePath={worktreePath} />`
   を追加。

この 3 つの変更はいずれも 1 行単位で孤立しているため、
upstream 側で多少の変更があっても衝突しにくい。

## データモデル

```ts
// packages/db/src/schema/todo-sessions.ts
export const todoSessions = pgTable("todo_sessions", {
  id: uuid().primaryKey().defaultRandom(),
  organizationId: uuid("organization_id").notNull().references(() => organizations.id),
  projectId: uuid("project_id").references(() => projects.id),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id),
  createdByUserId: uuid("created_by_user_id").references(() => users.id),

  title: text().notNull(),
  description: text().notNull(),
  goal: text().notNull(),
  verifyCommand: text("verify_command").notNull(),

  // Budget
  maxIterations: integer("max_iterations").notNull().default(10),
  maxWallClockSec: integer("max_wall_clock_sec").notNull().default(1800),

  // State
  status: text().notNull().default("queued"), // queued|preparing|running|verifying|done|failed|escalated|aborted
  phase: text(),
  iteration: integer().notNull().default(0),
  attachedPaneId: text("attached_pane_id"),

  // Verdict
  verdictPassed: boolean("verdict_passed"),
  verdictReason: text("verdict_reason"),
  verdictFailingTest: text("verdict_failing_test"),

  // Artifacts
  artifactPath: text("artifact_path").notNull(), // .superset/todo/<id>/

  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
  startedAt: timestamp("started_at"),
  completedAt: timestamp("completed_at"),
}, (table) => [
  index("todo_sessions_workspace_idx").on(table.workspaceId),
  index("todo_sessions_status_idx").on(table.status),
]);

export type InsertTodoSession = typeof todoSessions.$inferInsert;
export type SelectTodoSession = typeof todoSessions.$inferSelect;
```

ユーザー側で `bunx drizzle-kit generate --name="add_todo_sessions"` を実行する。
リポジトリポリシーに従い、こちらでは実行しない。

## tRPC サーフェス

```
todoAgent.create(input)           → { sessionId }
todoAgent.list(workspaceId)       → SelectTodoSession[]
todoAgent.get(sessionId)          → SelectTodoSession
todoAgent.attachPane(sessionId, paneId) → void
todoAgent.pause(sessionId)        → void
todoAgent.resume(sessionId)       → void
todoAgent.abort(sessionId)        → void
todoAgent.sendInput(sessionId, data) → void    (passthrough to terminal.write)
todoAgent.subscribeState(sessionId) → observable<SessionState>
```

すべての subscription は `observable` ヘルパーを使い、
`apps/desktop/AGENTS.md` に記載された trpc-electron の制約を満たす。

## 段階的な提供

**Phase 1（このブランチ）**
- DB テーブル + migration
- 単一タスク対応・キューなし・idle 検知ループ・child_process による verify を備えた
  Supervisor の骨組み
- ライブペイン埋め込み付きの `TodoButton` + `TodoModal` + `TodoPanel`
- Pause / Abort / Send Input

**Phase 2**
- キュー
  （複数セッションの逐次実行）
- Futility 検知の強化
- `--settings` を使った Stop hook 連携の任意対応
- Issue URL の自動取り込み
  （`gh issue view` → ゴールの事前入力）

**Phase 3**
- `done` 時の PR draft 自動作成
- 通知
- 追加 worktree による並列実行

## 未解決事項

- インストール済みの Claude Code バイナリが、セッション単位の hook 注入用に
  `--settings <path>` フラグをサポートしているかどうか。
  Phase 2 の確認項目とする。
- `verifyCommand` をワーカー PTY 内で実行するべきか、
  別 child process で実行するべきか。現行案では、
  verify 出力でユーザーに見えるターミナルを汚さないため、
  別 child process を使う。verify 出力をインラインで見たい要望が強ければ再検討する。
- クラウドワークスペース実行時に、artifact
  （`.superset/todo/<id>/`）をどこへ永続化するか。
  v1 ではローカル限定のため対象外。
