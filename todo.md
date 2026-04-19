# Browser Pane LLM Connect TODO

## 何をしたいのか

`apps/desktop` の `v1 workspace` にある browser pane 内ブラウザを、実行中の LLM セッションに明示的に接続できるようにしたい。

やりたい操作は次の通り。

- browser pane の toolbar から `Connect` を押す
- その場で実行中の LLM セッション一覧を開く
- Claude / Codex を最初の入口では分けず、後から任意の session を選ぶ
- 選んだ session に必要な browser MCP が入っていなければ、その場で導入方法を案内する
- MCP が入ったらその pane をその session に接続する
- すでに別 pane に接続済みの session を選んだ場合は、接続先を切り替えて再割当する
- 現在どの browser pane がどの session に繋がっているかを一覧ビューでも確認したい

重要なのは、**自動化したい対象は Superset アプリ全体ではなく、browser pane 内の webview だけ** という点。

## 今回のスコープ

今回の対応範囲は `v1 workspace` のみ。

- 対象: `apps/desktop/src/renderer/screens/main/components/WorkspaceView/...`
- 対象 UI:
  - browser pane toolbar 内の `Connect` 導線
  - session 選択モーダル
  - browser pane と session の割当一覧ビュー
- 対象データ:
  - browser pane と running LLM session のバインディング状態
  - session ごとの MCP ready / missing 状態

今回やらないこと:

- v2 workspace 対応
- Superset 全体 UI の自動化
- workspace shell 自体を CDP 対象にすること
- Playwright / chrome-devtools-mcp との完全統合実装
- 複数 owner による同時共有制御

## 期待する UX

### 1. Pane 側の主導導線

- browser pane toolbar に `Connect` ボタンを置く
- 未接続時は `Connect`
- 接続済み時は `Session 14 · Codex` のように表示
- クリックで session 選択モーダルを開く

### 2. セッション選択

- 実行中の session を一覧表示する
- provider 名で入口を分けない
- session ごとに最低限これを表示する
  - session 名
  - provider or agent 名
  - branch / title のような識別情報
  - 最終アクティブ時刻
  - MCP ready / missing
  - すでに別 pane に接続済みか

### 3. MCP 未導入時のガイド

- session を選んだ時点で MCP 未導入なら右カラムや同一モーダル内で案内を出す
- 接続ボタンは disabled にする
- どこに何を追加すればいいかを session 種別ごとに案内する
- 必要なら設定スニペットをコピーできるようにする

### 4. 再割当

- すでに別 pane を持っている session を新しい pane に接続した場合:
  - 旧 pane の接続を外す
  - 新 pane に session を再割当する
  - ユーザーに「移動した」ことが分かるフィードバックを出す

### 5. 一覧ビュー

- 右サイドまたは専用パネルに browser pane 一覧を出す
- 各 pane について次を表示する
  - pane 名
  - URL
  - 接続状態
  - 接続中 session 名
  - setup required 状態
- 一覧から pane を選ぶとその pane にフォーカスできる

## 画面モック

現時点の操作感モックはルートの `mock.html`。

このモックで確認したいこと:

- `Connect` の位置が自然か
- session 選択モーダルの情報量が適切か
- MCP missing ガイドを同じ導線内に置いて違和感がないか
- 一覧ビューが必要十分か
- 再割当の挙動が直感的か

## 実装対象の起点

現時点で主な起点になりそうな場所:

- browser pane 本体
  - `apps/desktop/src/renderer/screens/main/components/WorkspaceView/ContentView/TabsContent/TabView/BrowserPane/BrowserPane.tsx`
- content header / content shell
  - `apps/desktop/src/renderer/screens/main/components/WorkspaceView/ContentView/index.tsx`
  - `apps/desktop/src/renderer/screens/main/components/WorkspaceView/ContentView/ContentHeader/ContentHeader.tsx`
- workspace sidebar
  - `apps/desktop/src/renderer/screens/main/components/WorkspaceSidebar/WorkspaceSidebar.tsx`

## 設計方針

### 1. 制御単位

制御単位は `browser pane`。

- `1 browser pane = 1 webview target`
- 接続の主キーは `paneId`
- 実際に自動化する対象はその pane の webview のみ

### 2. バインディング単位

接続先は `LLM session`。

- Claude / Codex は session の属性であり、最初の UI 分岐には使わない
- バインディングは `paneId -> sessionId`
- 1 pane には最大 1 session
- 1 session も最大 1 pane

### 3. セッション状態

session ごとに最低限この状態を持つ。

- `sessionId`
- `displayName`
- `provider`
- `kind`
- `branchOrContextLabel`
- `lastActiveAt`
- `mcpStatus`
- `connectedPaneId`

`mcpStatus` はまず次の 3 値で十分。

- `ready`
- `missing`
- `unknown`

### 4. pane 状態

pane ごとに最低限この状態を持つ。

- `paneId`
- `tabId`
- `workspaceId`
- `title`
- `url`
- `connectedSessionId`
- `suggestedSessionId?`

## UI 詳細設計

### A. BrowserPane toolbar

`BrowserPane.tsx` の toolbar に接続状態 UI を追加する。

- 未接続:
  - ラベル `Connect`
- 接続済み:
  - `Session 14 · Codex`
- クリック時:
  - session connect modal を開く

必要なら secondary action:

- `Disconnect`
- `Change`

ただし最初は toolbar ボタン 1 個にまとめてもよい。

### B. Session Connect Modal

構成は 2 カラム。

左カラム:

- 現在の pane 情報
- running session 一覧

右カラム:

- 選択 session の詳細
- ready なら接続概要
- missing なら MCP 導入ガイド

footer actions:

- `Connect`
- `Disconnect current`
- `Cancel`

### C. 一覧ビュー

実装候補は 2 つ。

1. 既存右サイド領域に `Browser Automation` セクションを追加
2. browser pane 専用の軽量 list panel を追加

初手は 1 が現実的。

理由:

- v1 workspace のレイアウト変更が小さい
- 状態確認 UI を集約しやすい
- `mock.html` の方向性と近い

## 状態管理案

まずは renderer 側 store で十分。

候補:

- 既存 store 拡張
- 新規 `browser-automation` store 追加

保持する状態:

- `selectedSessionIdByPaneId`
- `sessions`
- `bindings`
- `connectModal`
  - `isOpen`
  - `paneId`
  - `selectedSessionId`

最初は永続化しなくてよい。

ただし将来的に欲しくなりそうなもの:

- 最後に選んだ session
- pane ごとの前回接続先

## 実装段階

### Phase 1: UI モックを実装に寄せる

- `mock.html` を基準に、実アプリの v1 UI へ落とす
- toolbar の `Connect` 導線を本実装に置き換える
- session modal を renderer に実装する
- 一覧ビューを暫定で出す

### Phase 2: セッション一覧の実データ化

- 実行中 LLM session の列挙元を決める
- session ごとの provider / title / branch / MCP 状態を収集する
- session 選択 UI をダミーデータから実データへ置換する

### Phase 3: バインディング管理

- `paneId -> sessionId` バインディングを store で管理
- 接続
- 切断
- 再割当
- UI 反映

### Phase 4: MCP 状態の扱い

- session ごとの MCP ready 判定を実装する
- missing の時は案内を表示する
- provider ごとに設定先や表示文言を分ける

### Phase 5: 実 automation bridge 接続

- session 側が使う `superset-browser` MCP の仕様を決める
- `paneId` を session に渡す方法を決める
- 必要なら Desktop 側 API を追加する

## 技術課題

### 1. Running session の取得元

未整理ポイント。

- どこから「今動いている Claude/Codex session 一覧」を取るか
- renderer で直接見えるのか
- main 側管理なのか
- 既存の agent session 周りの仕組みを再利用できるか

ここは最初に確認が必要。

### 2. MCP ready 判定

未整理ポイント。

- session ごとに MCP が入っているかをどう判定するか
- config 実ファイルを見るのか
- 起動時の session metadata を見るのか
- handshake 結果で見るのか

最初は `unknown` を許容してもよい。

### 3. 実際の pane 制御との接続

最終的には browser pane の webview を session に結びたい。

必要になりそうなもの:

- `paneId` 解決
- webview / browser target 取得
- screenshot / evaluate / navigation などの基盤

ただし今回の `todo.md` 段階では、まず UX と binding 設計を優先する。

## 受け入れ条件

最低限これができれば第一段階として成立。

- v1 workspace の browser pane に `Connect` 導線がある
- Connect から running session を選べる
- Claude / Codex で最初に分岐しない
- MCP missing の session では設定案内が出る
- ready な session は接続できる
- 接続済み session は別 pane へ再割当できる
- 現在の割当状態を一覧で見られる

## すぐ着手する順番

1. v1 workspace における一覧ビューの配置場所を決める
2. running session のデータ取得元を確認する
3. renderer store の形を決める
4. BrowserPane toolbar に `Connect` を仮実装する
5. session connect modal を組み込む
6. 一覧ビューを組み込む
7. 実データ配線に進む

## メモ

- 入口は browser pane 側に置く
- provider ではなく session を選ばせる
- missing MCP を「失敗」ではなく「案内」に変える
- 一覧ビューは必要
- 対応範囲は v1 workspace 限定
