# TODO Agent スケジュール実行 実装計画

既存の TODO 自律エージェントに **cron ライクな定期実行** 機能を追加する。
ユーザーはスケジュールを登録しておくと、指定時刻にそのプロンプトで TODO セッションが自動作成・キュー投入される。

## 目的

- 「毎日 9:00 にデプロイ」「1時間ごとに lint 走らせる」のような
  定型的な AI タスクを手動トリガーなしで実行できる。
- 既存の TODO 作成フロー・実行エンジン (supervisor) をそのまま再利用し、
  スケジュール層は薄く、単純にトリガー役に徹する。
- フォーク限定機能。`apps/desktop` 内に閉じる。

## 前提 (ユーザー決定事項)

1. 発火通知は **トースト**
2. cron 式の直接入力ではなく **UX 重視のビルダー UI** (プリセット + カスタム)
3. 前回実行中の発火時の挙動 (skip / queue) は **スケジュール毎にユーザーが選択**
4. UI は TodoManager **内に統合** (独立モーダルにはしない)

## 非目的 (v1)

- missed firing の補完 (閉じてた間の発火を後で実行): 初回は **skip + 通知のみ**
- タイムゾーン切替: ローカル TZ 固定
- スケジュール間の依存関係 / 順序制御
- スケジュール共有 (エクスポート/インポート)

## アーキテクチャ

```
Renderer                             Main process
────────                             ────────────
TodoManager                          TodoScheduler (singleton)
 └─ SchedulesSection                  ├─ tick (setInterval every 30s)
     ├─ ScheduleList                  ├─ compute nextRunAt for each schedule
     └─ ScheduleEditor                │   and compare to now
        └─ ScheduleFrequencyPicker    ├─ on fire:
                                      │    ├─ check overlap mode
                                      │    ├─ call TodoSupervisor.createFromSchedule()
                                      │    └─ emit `schedule.fired` event
                                      └─ scheduleStore (SQLite)

trpc todoAgent.schedule.*            ─► scheduleStore CRUD
trpc todoAgent.schedule.onFire  ─► observable<ScheduleFiredEvent>
                                      (for toast in renderer)
```

## DB schema (`packages/local-db/src/schema/todo-schedules.ts`)

```ts
todo_schedules {
  id:                text pk
  workspaceId:       text (FK workspaces, cascade)
  projectId:         text (FK projects, set null)
  name:              text not null         -- 表示名
  enabled:           int bool not null dflt 1

  -- スケジュール定義 (UI ビルダー経由で設定)
  frequency:         text enum("hourly","daily","weekly","monthly","custom") not null
  minute:            int         -- 0-59 (hourly+)
  hour:              int         -- 0-23 (daily+)
  weekday:           int         -- 0-6, 0=Sun (weekly)
  monthday:          int         -- 1-31 (monthly)
  cronExpr:          text        -- frequency=custom のときのみ

  -- 発火時に作成する TODO の雛形
  title:             text not null
  description:       text not null
  goal:              text
  verifyCommand:     text
  maxIterations:     int not null dflt 10
  maxWallClockSec:   int not null dflt 1800
  customSystemPrompt:text

  overlapMode:       text enum("skip","queue") not null dflt "skip"

  lastRunAt:         int
  lastRunSessionId:  text
  nextRunAt:         int         -- 予測値。tick で使う
  createdAt:         int
  updatedAt:         int
}

index (workspaceId), (enabled, nextRunAt)
```

マイグレーション生成:
```sh
cd packages/local-db
bun run generate --name=add_todo_schedules
```

## スケジューラ (`apps/desktop/src/main/todo-agent/scheduler.ts`)

- `setInterval(tick, 30_000)` でポーリング
- tick: 有効なスケジュールを DB から取得、`nextRunAt <= now` なものを発火
- 発火:
  1. overlap チェック (skip なら、同 scheduleId の未完了セッションがあればスキップ)
  2. `TodoSupervisor.createFromSchedule(schedule)` で TODO セッションを作成
  3. `session-store` に挿入 → 既存のキュー機構に乗る
  4. `lastRunAt = now`, `lastRunSessionId = ...`, `nextRunAt = computeNext(schedule, now)` を保存
  5. `schedule.fired` イベントを emit → UI 側のトースト購読に届く
- `nextRunAt` 計算は frequency enum に応じた専用ヘルパ (custom のみ cron パース)
- cron パースは `cron-parser` (小さい・7日以上前のリリース確認必須)

## UI (統合: TodoManager 内 Schedules セクション)

配置: TodoManager の左サイドバーにタブ「Tasks / Schedules」を追加。

### ScheduleList
- 行: enable トグル / 名前 / 次回実行時刻 / 最終実行結果 / ... メニュー (edit / delete)
- 空状態: "+ New Schedule" ボタン

### ScheduleEditor (ダイアログ)

ビルダー UI:
1. **名前**: テキスト
2. **ワークスペース**: select (existing workspaces)
3. **プロンプト**: 既存の TodoComposer と同じ UI (description / goal / verify / preset / attachments)
4. **頻度ビルダー**:
   - Hourly: `毎時 :MM 分`
   - Daily: `毎日 HH:MM`
   - Weekly: `毎週[曜日] HH:MM` (曜日チップ複数選択)
   - Monthly: `毎月 DD 日 HH:MM`
   - Custom: raw cron 式入力 + `cronstrue` でヒューマン表示
5. **重複時の挙動**: radio `前回が走っていたらスキップ` / `キューに追加`
6. **有効/無効**: トグル

次回実行予定をプレビュー表示 (`cronstrue` の locale=ja-JP).

## トースト

`electronTrpc.todoAgent.schedule.onFire.useSubscription` を TodoManager or
グローバルプロバイダで購読し、以下を表示:

- 成功: `📅 {name} を実行しました` (→ セッション詳細への遷移リンク)
- skip: `⏭️ {name} の実行をスキップしました (前回が実行中)`

## 実装ファイル一覧 (新規のみ)

### Backend
- `packages/local-db/src/schema/todo-schedules.ts`
- `packages/local-db/drizzle/00XX_add_todo_schedules.sql` (自動生成)
- `packages/local-db/src/schema/index.ts` (追記)
- `apps/desktop/src/main/todo-agent/scheduler.ts`
- `apps/desktop/src/main/todo-agent/schedule-store.ts`
- `apps/desktop/src/main/todo-agent/trpc-router.ts` (nested `schedule` router 追記)
- `apps/desktop/src/main/todo-agent/supervisor.ts` (`createFromSchedule` 追加)

### Frontend
- `apps/desktop/src/renderer/features/todo-agent/TodoManager/SchedulesSection/SchedulesSection.tsx`
- `apps/desktop/src/renderer/features/todo-agent/TodoManager/SchedulesSection/components/ScheduleList/ScheduleList.tsx`
- `apps/desktop/src/renderer/features/todo-agent/TodoManager/SchedulesSection/components/ScheduleEditor/ScheduleEditor.tsx`
- `apps/desktop/src/renderer/features/todo-agent/TodoManager/SchedulesSection/components/FrequencyBuilder/FrequencyBuilder.tsx`
- `apps/desktop/src/renderer/features/todo-agent/TodoManager/SchedulesSection/hooks/useScheduleFireToast/useScheduleFireToast.ts`
- `apps/desktop/src/renderer/features/todo-agent/TodoManager/TodoManager.tsx` (タブ追加・1箇所変更)

### 依存パッケージ追加
- `cron-parser` (main side; for custom cron parsing + next-fire computation)
- `cronstrue` (renderer; human-readable cron)
両方とも 7日以上前のリリースが存在する安定 lib。

## テスト計画

- `scheduler.test.ts`: frequency → nextRunAt 計算, overlap 判定
- `schedule-store.test.ts`: CRUD / inserted の shape
- `FrequencyBuilder` の簡易描画テスト (optional)

## ロールアウト

1. DB schema + migration
2. scheduler + store + tRPC
3. TodoManager UI 統合
4. トースト
5. 型チェック + lint + 既存 todo セッションテストに干渉しないことを確認
6. PR → セルフレビュー → マージ

## リスクと対策

| リスク | 対策 |
|------|------|
| アプリ閉じてる間の発火が消える | v1 は諦める。UI に「アプリ起動中のみ」明記 |
| 破壊的コマンドの暴走 | `verifyCommand` は既存通り任意。ユーザー責任。初期はドキュメントで警告 |
| スケジュールの重複暴発 | overlapMode=skip デフォルト + DB index で pending 検出 |
| Claude API 料金の想定外消費 | maxIterations / maxWallClockSec は既存制約をそのまま使う |
| タイムゾーンずれ | ローカル TZ 固定。将来 tz 列追加で拡張可能 |
