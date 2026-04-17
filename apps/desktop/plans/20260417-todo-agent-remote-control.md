# TODO Agent Remote Control 統合 計画

## 背景

Claude Code CLI は v2.1.51 で `claude remote-control` / `claude --remote-control` / スラッシュコマンド `/remote-control` を提供し、ローカルで走っているセッションを claude.ai/code や Claude iOS/Android アプリから閲覧・操作できるようになった。

TODO Agent は現在 `claude -p --output-format stream-json` をサブプロセスで起動して stdout の NDJSON を parse するヘッドレス方式で動いている。これは Remote Control と互換性がない (`-p` は Ink TUI を持たず、interactive 端末 UI を要求する `/remote-control` を受けられない)。

本 PR は PTY + JSONL tail ベースの代替エンジンを feature flag 付きで追加し、Remote Control を opt-in で使えるようにする。

## 検証済み事実 (手元 POC 完了)

- interactive `claude --permission-mode bypassPermissions --settings '<inline JSON>'` で Stop / UserPromptSubmit / PreToolUse / PostToolUse / SessionStart hook を inline 注入可能
- `~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl` は interactive モードでも書き込まれる。spawn 後 3 秒以内に生成される
- interactive モードの `--session-id <uuid>` は JSONL ファイル名を制御**しない** (別 UUID が内部生成される)。`fs.watch` で project dir の新規ファイルを自セッションとして同定する必要がある
- JSONL event type: `system` / `user` / `user(tool_result)` / `assistant(thinking|text|tool_use)` / `attachment` / `permission-mode` / `file-history-snapshot` / `queue-operation` / `last-prompt`
- PTY への bracketed paste (`\x1b[200~...\x1b[201~\r`) で prompt 投入成功
- `/remote-control\r` で stdout に `https://claude.ai/code/session_...` が表示される
- mid-session で追加プロンプトを送信可能

## アーキテクチャ

### 選択肢比較

| 案 | Remote Control | Live stream | コスト | 採否 |
|----|----------------|-------------|--------|------|
| A. 現状 `-p` | 不可 | ○ | 0 | 部分採用 (既定・非 RC 系は当面これ) |
| B. Agent SDK | 不可 (API key 必須) | ○ | 大 | 却下 |
| C. PTY + JSONL tail | ○ | △ (per-token なし / whole message) | 中 | **本 PR で採用** |
| D. Dual process | △ (競合) | ○ | 小 | 却下 (会話競合リスク) |

### 案 C の構成

```
[daemon]
 ├── supervisor-engine.ts  (従来 -p エンジン / 既定)
 │    └── runClaudeTurn()  : stream-json stdout parse
 │
 └── pty-turn-runner.ts     (新規 PTY エンジン / opt-in)
      └── runClaudeTurnPty()
           ├── node-pty spawn
           │    claude --permission-mode bypassPermissions
           │           --settings '<inline JSON with Stop hook>'
           │           [--model ...] [--effort ...]
           │           [--resume <id>]
           │
           ├── fs.watch(~/.claude/projects/<encoded-cwd>/)
           │    → 新規 .jsonl を自セッションとして同定
           │
           ├── chokidar 相当の poll + offset tracking
           │    → assistant / user(tool_result) / assistant(tool_use) を
           │      supervisor-engine と同じ TodoStreamEvent 形に変換
           │
           ├── Stop hook 発火 (Unix/tmp ファイル経由) で turn 終了検知
           │
           ├── Remote Control 有効時のみ PTY stdin に `/remote-control\r`
           │    → PTY stdout を ANSI strip 後 `https://claude.ai/code/session_...`
           │      を抽出してセッションに保存
           │
           └── bracketed paste で prompt 投入 / 次ターンも同じ PTY 再利用 ...
                ではなく、既存 supervisor の iteration ループに合わせて
                **1 ターン 1 プロセス** とし、次 iteration は
                `--resume <claudeSessionId>` で再 spawn する
```

**重要な設計判断: 1 ターン 1 プロセス**  
既存 `supervisor-engine.ts` は iteration ごとに `claude -p` を spawn → exit する。PTY 版もこのライフサイクルに合わせ、1 ターンごとに PTY プロセスを起こして Stop hook で終了させる。これで:

- 既存 `runSession` ループを変更せず `runClaudeTurn` を差し替えるだけで済む
- ScheduleWakeup の既存処理 (waiting 状態 → 別プロセスで resume) がそのまま動く
- Intervention (追加メッセージ) も既存の queue → 次 iteration 投入フローで動く
- 長命プロセスのリソース管理問題を回避

### Feature flag

- 環境変数 `TODO_ENGINE=pty` で PTY エンジンに切り替え (既定: headless)
- セッション単位の `remote_control_enabled` フラグは UI チェックボックスで opt-in
  - PTY エンジン + `remote_control_enabled=true` の AND 条件で Remote Control 発動
  - チェックボックスは `TODO_ENGINE=pty` が無効なときは disabled

## DB schema 変更

`todo_sessions` に 1 列追加:

```sql
ALTER TABLE todo_sessions ADD COLUMN remote_control_enabled INTEGER DEFAULT 0;
```

- `remote_control_session_url` は **永続化しない**。daemon 再起動で RC セッションは切れるため、URL は in-memory + stream event のみで表現
- Remote Control 状態は stream event で live-stream に流す

## UI 変更

- `TodoModal`: 「Remote Control を有効化」チェックボックス追加 (PTY mode 時のみ有効)
- `ScheduleEditorDialog`: 同様のチェックボックス追加
- `TodoManager` live stream: RC 接続中バッジ + URL リンクを stream events から読んで表示

## 実装順序

1. plan.md 追加 (本文書)
2. DB schema: `remote_control_enabled` 列追加
3. PTY turn runner 本体 (`pty-turn-runner.ts`)
4. supervisor-engine 側の feature flag 分岐
5. StartRequest / tRPC 入出力 に RC フィールド追加
6. TodoModal / ScheduleEditorDialog UI
7. live stream バッジ表示
8. lint / typecheck / 自己レビュー
9. commit / push / PR

## フォローアップ (後続 PR)

- dogfood 後 `-p` エンジン削除
- per-token streaming (JSONL には text_delta が無いので別経路を検討)
- mid-session メッセージ送信 UI (`queueIntervention` 拡張)
- Remote Control URL の永続化 + セッション再接続導線
- 並列起動時の race 対策強化
- Electron パッケージでの node-pty ネイティブ rebuild 確認 (既に terminal-host で使用中)

## 前提条件

- `claude auth login` 済 (claude.ai OAuth)
- Claude Code v2.1.51+
- Pro/Max/Team/Enterprise プラン
- Team/Enterprise は admin が Remote Control トグルを有効化済
