# Browser Pane ×  LLM Binding Roadmap

> このドキュメントは、Superset Desktop の「複数 pane ×  複数 LLM」ブラウザ自動化
> 機能を **CDP エンドポイント公開型 (Phase B)** へ進化させるための実装計画。
> 途中で作業コンテキストが失われても再開できるよう、最終形と途中 PR の境界を
> ここに固定する。

## 最終的に作りたい体験

1. Superset Desktop を起動すると、複数のプロジェクト / ワークスペースを横断して
   好きなプロダクトのフロントエンドを **browser pane** として開ける。
2. UI の **Connect** ボタンで pane と LLM session (Claude / Codex など) を
   **1 対 1** でアタッチし、好きなタイミングで別の LLM に繋ぎ変えられる。
3. LLM は自分側で好きな browser 自動化 MCP を使う:
   - `chrome-devtools-mcp` (Google)
   - `browser-use` (Python/Playwright)
   - `playwright-mcp` など
   これらは **成熟した外部プロジェクト**。自前で再実装しない。
4. Superset は **バインディングルーター** として動く:
   - 各 pane を独立した CDP (Chrome DevTools Protocol) エンドポイントに見せる
   - session token 付き URL で外部 MCP が接続
   - 別 pane はそもそも見えない (フィルタプロキシ)
5. pane ↔ session の紐付けを UI から差し替えると、外部 MCP が使っている CDP
   endpoint の backing pane がホットスワップされ、LLM はそのまま別 pane を操作
   できるようになる。

## 現状 (PR #354 マージ済み)

- `packages/superset-browser-mcp` (独立パッケージ) を同梱
- 起動時に `~/.superset/browser-mcp.json` (workspace スコープ) に
  port / secret を書き出す HTTP bridge
- PID ベースの自動セッションマッピング (terminal pane 限定)
- UI `McpInstallPanel`: Claude / Codex 選択してワンクリック install
- バインディングは local-db に永続化
- Phase A 相当の薄い tools: `get_connected_pane` / `navigate` / `screenshot`
  / `evaluate_js` / `get_console_logs` （= 自前 CDP 実装で十分薄い）

### 現状の限界

- navigate/screenshot/... を全部自作しているため、tools の表現力が外部 MCP に
  追いつかない。
- pane 単位の CDP エンドポイントは露出していない。

## Phase B PR ロードマップ

### PR1: CDP エンドポイント公開（pane → Chromium targetId 解決）

- Superset 起動時に `--remote-debugging-port=0` (ランダム port) を有効化
- Chromium の `/json/list` を取得して pane ごとの targetId を特定する仕組み
  - 実装案: pane 生成時に `window.__supersetPaneId = "<paneId>"` を注入、
    `/json/list` の各 page target に `Runtime.evaluate` でマッチング
- 新 tRPC / MCP tool `get_cdp_endpoint()`:
  - 入力: session PPID (既存のヘッダ)
  - 出力:
    ```json
    {
      "webSocketDebuggerUrl": "ws://127.0.0.1:<port>/devtools/page/<id>",
      "targetId": "<id>",
      "paneId": "<pane>",
      "url": "https://...",
      "title": "..."
    }
    ```
- **この PR では生の CDP URL を返すだけ**。フィルタリングは PR2 で。
  外部 MCP が接続すると他 pane も見えるが、動作検証のマイルストーンとして価値あり。
- 既存の webContents.debugger.attach 経路は navigate/screenshot のままにして共存。

### PR2: CDP WebSocket フィルタプロキシ（pane 単位の分離）

- Superset main に CDP proxy を追加:
  - `http://127.0.0.1:<port2>/cdp/<session-token>/json`
    → bound pane 1 つだけを返す (他 pane / devtools / workspace shell は隠す)
  - `ws://127.0.0.1:<port2>/cdp/<session-token>/devtools/page/<id>`
    → Chromium の CDP へ透過プロキシ。`Target.*` コマンドだけフィルタ:
      - `Target.setDiscoverTargets` / `Target.getTargets` は bound pane のみ返す
      - `Target.attachToTarget` は bound pane 以外拒否
      - `Target.targetCreated` / `Target.targetDestroyed` イベントも pane フィルタ
  - 認証: session-token + loopback 限定
- `get_cdp_endpoint()` が返す URL を **フィルタ版** に差し替え
- セキュリティテスト: 別 pane を誤って見せないユニットテスト
- バインディングを別 pane にホットスワップした時、WS セッションを
  `Target.detachFromTarget` で繋ぎ直す or 切断してクライアントに再接続させる
  挙動を実装

### PR3: UI に外部 MCP 接続ガイド

- Connect モーダルに「外部ブラウザ MCP を使う場合」セクションを追加
- ワンクリックでコピーできる例:
  ```
  # chrome-devtools-mcp
  claude mcp add chrome-devtools-mcp -s user -- \
    npx -y chrome-devtools-mcp --browser-url <filtered-cdp-url>

  # browser-use (pyproject 経由)
  browser-use --cdp-url <filtered-cdp-url>
  ```
- `<filtered-cdp-url>` は `get_cdp_endpoint` 相当の値を main process で生成
- Connect 後の pane 情報画面 (ReadyPanel) にも「この pane の CDP endpoint」
  リンクを常設し、別の LLM クライアントから直接叩けるように

### PR4: 古い自作 tools の整理

- PR1〜3 で代替が整い次第、以下の MCP tools を deprecated にするか削除:
  - `navigate` / `screenshot` / `evaluate_js` / `get_console_logs`
  - 対応する HTTP bridge エンドポイントも
- 残すのは:
  - `get_cdp_endpoint` (メイン出口)
  - `get_connected_pane` (メタ情報用 sanity check)
- `webContents.debugger.attach` 経路は不要になるので削除
- README / PR 本文で「外部 MCP を使ってください」案内
- リリースノートで破壊的変更を明示 (旧 tools を叩いてくるカスタム自動化は動かなく
  なる)

## 設計上の注意

### Chromium target ID と Electron webContents のマッピング

- `/json/list` には Electron の `webContents.id` が直接出ない。
- 確実なマッチング: 各 pane の load 完了時に
  `webContents.executeJavaScript("window.__supersetPaneId = '<pane>'")`
  を注入しておき、`/json/list` の各 target に対して `Runtime.evaluate` で拾う。
- pane の navigation で JS コンテキストが消えると `__supersetPaneId` も消える
  → `did-navigate` フックで毎回注入する必要あり。

### Electron の debugger と外部 CDP の同居

- Chromium M100+ は同一 target への複数 CDP セッションを flatten mode で許容
  するが、Electron `webContents.debugger.attach()` と外部 `chrome-devtools-mcp`
  が同時 attach できるかは要検証。
- 干渉するなら Electron debugger 側を detach して外部に譲る仕組みが要る。
- PR1〜2 の間にサンプルで 1 度試す。

### セキュリティ

- loopback 限定は bridge 側ですでにやっている
- session token は 32 バイト乱数で十分
- Target コマンドフィルタにバグがあると他 pane へ波及する → Phase B は
  自動テスト必須

### マルチ Superset インスタンス

- 既に `${SUPERSET_HOME_DIR}/browser-mcp.json` で workspace スコープ化済み
- CDP フィルタプロキシの port も同じ runtime file に追加 (`cdpPort` フィールド)
  → 外部 MCP は token 付き URL だけ見れば済む

## やらないこと（Phase C 以降、保留）

- superset-browser-mcp 内部で chrome-devtools-mcp を subprocess として起動し
  tools を forward する「MCP-to-MCP ブリッジ」
  - Phase B で 90% の価値は出るため優先度低い
- TODO-Agent worker 経由のブラウザ自動化
  - Claude worker PID が daemon プロセス側にあり、bridge からは resolve できない
  - Phase B が安定してから daemon-bridge IPC 経由で対応

## 参考実装 / 外部 MCP

- https://github.com/ChromeDevTools/chrome-devtools-mcp
- https://github.com/browser-use/browser-use
- https://github.com/microsoft/playwright-mcp
