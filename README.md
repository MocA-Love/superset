<div align="center">

<img width="full" alt="Superset" src="apps/marketing/public/images/readme-hero.png" />

### The Code Editor for AI Agents

[![GitHub stars](https://img.shields.io/github/stars/superset-sh/superset?style=flat&logo=github)](https://github.com/superset-sh/superset/stargazers)
[![GitHub release](https://img.shields.io/github/v/release/superset-sh/superset?style=flat&logo=github)](https://github.com/superset-sh/superset/releases)
[![License](https://img.shields.io/github/license/superset-sh/superset?style=flat)](LICENSE.md)
[![Twitter](https://img.shields.io/badge/@superset__sh-555?logo=x)](https://x.com/superset_sh)
[![Discord](https://img.shields.io/badge/Discord-555?logo=discord)](https://discord.gg/cZeD9WYcV7)

<br />

Orchestrate swarms of Claude Code, Codex, and more in parallel.<br />
Works with any CLI agent. Built for local worktree-based development.

<br />

[**Download for macOS**](https://github.com/superset-sh/superset/releases/latest) &nbsp;&bull;&nbsp; [Documentation](https://docs.superset.sh) &nbsp;&bull;&nbsp; [Changelog](https://github.com/superset-sh/superset/releases) &nbsp;&bull;&nbsp; [Discord](https://discord.gg/cZeD9WYcV7)

<br />


</div>

## Fork 固有の変更点

このリポジトリは [superset-sh/superset](https://github.com/superset-sh/superset) のフォークです。以下の独自変更が含まれています。

| 変更 | 概要 | PR | 追加日 |
|:-----|:-----|:--:|:------:|
| **Excel/スプレッドシート ビューア** | .xlsx/.xls/.ods ファイルを書式付きで表示。罫線・結合セル・テーマカラー・リッチテキスト対応。複数シートタブ切り替え、コンテナ幅への自動フィット | [#1](https://github.com/MocA-Love/superset/pull/1) | 2026-03-27 |
| **Excel diff ビューア** | スプレッドシートのサイドバイサイド差分表示。セル単位の変更ハイライト、Prev/Next ナビゲーション、左右同期スクロール | [#1](https://github.com/MocA-Love/superset/pull/1) | 2026-03-27 |
| **フォーク版アップデート通知** | 本家 electron-updater を無効化し、GitHub API でフォークリリースをチェックする方式に変更。新バージョン検出時にトースト通知を表示し「Open releases」からダウンロードページへ遷移。4時間ごと＋起動時に自動チェック | [#3](https://github.com/MocA-Love/superset/pull/3) [#17](https://github.com/MocA-Love/superset/pull/17) | 2026-03-29 |
| **ブラウザ webview リロード防止** | タブ/ワークスペース切り替え時に Electron の webview がリロードされる問題を修正。webview を含むタブを keep-alive し、ワークスペースページをルーター上位で保持。WorkspaceIdContext による正しいコンテキスト分離、ホットキーの active-only 制御も実装 | [#2](https://github.com/MocA-Love/superset/pull/2) | 2026-03-28 |
| **マウス戻る/進むボタン対応** | ブラウザ webview 内でマウスの戻る/進むボタンが動作するように対応。macOS は guest ページへのスクリプト注入、Windows/Linux は app-command イベントで処理 | [#2](https://github.com/MocA-Love/superset/pull/2) | 2026-03-28 |
| **AI コミットメッセージ生成** | コミットメッセージ入力欄のスパークルボタンで AI が conventional commit メッセージを日本語で自動生成。階層的要約方式（gptcommit 式）により大量差分でも高精度。staged/unstaged/untracked 全対応、lock ファイル・バイナリ自動スキップ | [#4](https://github.com/MocA-Love/superset/pull/4) | 2026-03-28 |
| **ポートリストのリサイズ・フィルタ** | サイドバーの Ports セクションの高さをドラッグでリサイズ可能に（80–600px、永続化）。フィルタトグルで ports.json に定義されたポートのみ表示し、自動検出ポートを非表示にできる | [#6](https://github.com/MocA-Love/superset/pull/6) | 2026-03-28 |
| **大規模ファイル diff 高速化** | 2000行超のファイルで CodeMirror 6 ベースの仮想化 diff ビューアに自動切替。ビューポート分のDOMのみ描画し、15000行でもスムーズ表示。既存テーマ・シンタックスハイライト再利用、未変更領域の自動折りたたみ | [#5](https://github.com/MocA-Love/superset/pull/5) | 2026-03-28 |
| **ports.json ポートの常時表示** | ports.json に定義されたポートをプロセス検出の有無にかかわらず常にサイドバーに表示。Docker 等で検知できないポートもラベル付きで一覧に出る。検出済みポートは従来通りアクティブ表示、未検出は グレー表示で区別 | [#7](https://github.com/MocA-Love/superset/pull/7) | 2026-03-28 |
| **Ports ワークスペース名の改善** | Ports セクションのワークスペース名をワークツリーのディレクトリ名ベースに変更。同名ワークスペースが複数ある場合でもどのワークツリーか一目で区別可能 | [#8](https://github.com/MocA-Love/superset/pull/8) | 2026-03-28 |
| **ブラウザタブ機能強化** | ズーム倍率表示と [-]/[+] ボタン（Cmd+/- と同期）、target="_blank" リンクや Cmd+click を新しいブラウザタブで開く機能、URL コピーボタンを追加。タブが非表示中でもリンクイベントを正しく処理するグローバルハンドラ実装 | [#10](https://github.com/MocA-Love/superset/pull/10) | 2026-03-29 |
| **タブのポップアウト** | ペインツールバーの Pop out ボタンでタブを独立ウィンドウとして分離。閉じるとメインウィンドウに自動返却。ターミナルセッション維持、preload 同期注入方式で Zustand persist との競合を排除 | [#11](https://github.com/MocA-Love/superset/pull/11) | 2026-03-29 |
| **タブカラー設定** | タブを右クリック → Set Color で13色から背景色を設定可能。ワークスペースセクションと同じカラーパレットを再利用。アクティブ/非アクティブで濃淡が変化し、設定は自動永続化 | [#12](https://github.com/MocA-Love/superset/pull/12) | 2026-03-29 |
| **クラッシュリカバリー強化** | macOS でアプリが白画面/フリーズする問題を修正。GPU クラッシュ時に最大化/フルスクリーンでもコンポジター再構築を実行、レンダラークラッシュ時の自動リロード/再起動、clipboard 操作のエラーハンドリング追加 | [#13](https://github.com/MocA-Love/superset/pull/13) | 2026-03-29 |
| **Excel 描画オブジェクト・斜線表示** | Excel ファイルの描画オブジェクト（線・矩形）とセル斜線を表示。xlsx ZIP から drawing XML を直接パースし、CSS transform 方式の SVG オーバーレイで正確に配置 | [#16](https://github.com/MocA-Love/superset/pull/16) | 2026-03-29 |
| **Chrome 拡張機能インストール** | Chrome Web Store の URL または拡張 ID からブラウザ拡張機能をインストール。CRX ダウンロード・展開、互換性チェック（Electron 非対応 API 検出）、設定画面での管理（有効/無効/削除）。BrowserPane ツールバーに拡張アイコンを表示し、クリックでポップアップウィンドウを表示。GPL ライブラリ不使用、Electron 標準 API のみで自前実装 | [#20](https://github.com/MocA-Love/superset/pull/20) | 2026-03-29 |
| **Excel diff インラインハイライト** | Excel 差分表示で変更セル内のテキスト差分を文字レベルでインライン表示。追加部分は緑、削除部分は赤+取り消し線。セルからはみ出る場合はホバーでツールチップにフル差分を表示 | [#19](https://github.com/MocA-Love/superset/pull/19) | 2026-03-29 |
| **Files タブのツールチップ** | ファイルツリーのファイル/フォルダ名にホバーで相対パスをツールチップ表示。ツールバーのトグルボタンで ON/OFF 切り替え、設定は永続化 | [#22](https://github.com/MocA-Love/superset/pull/22) | 2026-03-29 |
| **Inspect Element（右クリック検証）** | ブラウザペインの右クリックメニューに「Inspect Element」を追加。クリック位置の要素を直接 DevTools でインスペクト可能 | [#23](https://github.com/MocA-Love/superset/pull/23) | 2026-03-30 |
| **Branch ワークスペースの PR 表示対応** | worktree を切らない「branch」タイプのワークスペースでも Review タブに PR 情報・チェック結果・レビューコメントを表示。`getGitHubStatus` / `getGitHubPRComments` が worktree レコード必須だった制限を、`mainRepoPath` へのフォールバックで解消 | [#24](https://github.com/MocA-Love/superset/pull/24) | 2026-03-30 |
| **シェル履歴サジェスト** | ターミナル入力時に ~/.zsh_history からコマンド候補をドロップダウン表示。↑↓で選択、→で確定、Escで破棄。選択中コマンドのフルプレビュー付き（補完部分を緑色で強調）。8件超はスクロール、末尾到達で追加読み込み。設定画面から ON/OFF 切り替え可能 | [#24](https://github.com/MocA-Love/superset/pull/24) | 2026-03-30 |
| **Sentry エラー監視統合** | 自前の Sentry プロジェクトと連携可能。`.env` に `SENTRY_DSN_DESKTOP` を設定するだけで本番ビルドのクラッシュ・エラーを自動収集 | [#26](https://github.com/MocA-Love/superset/pull/26) | 2026-03-30 |
| **デスクトップ安定性修正** | シェル履歴サジェストが表示されないバグ（useEffect 依存配列の問題）、アプリ終了時の napi_fatal_error クラッシュ（SQLite 未クローズ）、webview パーキング後の getURL() エラー、サイドバーリサイズが webview 上で効かない問題を修正 | [#26](https://github.com/MocA-Love/superset/pull/26) | 2026-03-30 |
| **Review パネル強化** | GitHub Actions チェックを展開してジョブ内ステップの進捗を表示。レビューコメントを展開して Markdown レンダリング全文表示（GitHub Alerts 対応）。コメントのファイルパス+行番号クリックでエディタの該当行にジャンプ | [#27](https://github.com/MocA-Love/superset/pull/27) | 2026-03-30 |
| **サジェストバグ修正** | ドロップダウンのはみ出し防止（上側表示切替）、alternate screen（Claude Code等）中のサジェスト完全抑制（4層防御）、Agent操作中の非表示化、日本語文字化け修正（zsh metafied エンコーディング対応） | [#31](https://github.com/MocA-Love/superset/pull/31) | 2026-03-30 |
| **サジェスト履歴削除** | サジェスト一覧の各候補にバツボタンを追加し、クリックで ~/.zsh_history から直接削除。atomic write でファイル破損防止、metafied エンコーディング対応 | [#34](https://github.com/MocA-Love/superset/pull/34) | 2026-03-30 |
| **ブラウザアドレスバー選択修正** | アドレスバーでURLをマウスドラッグで範囲選択しようとするとペインが移動する問題を修正。input の mousedown イベント伝播を阻止 | [#34](https://github.com/MocA-Love/superset/pull/34) | 2026-03-30 |
| **git blame インライン表示** | ファイルビューアで行番号横に blame 情報をインライン表示。行ホバーで作者・コミットメッセージ・日時のポップアップを表示。表示タイミングを修正し、ファイル切り替え後も正しく動作 | [#38](https://github.com/MocA-Love/superset/pull/38) | 2026-03-31 |
| **マージコンフリクト解消 UI** | diff ビューア内でコンフリクトマーカーをインラインで検出し、VSCode スタイルの「Accept Current / Accept Incoming / Accept Both」ボタンを表示。ワンクリックでコンフリクトを解消可能 | [#38](https://github.com/MocA-Love/superset/pull/38) | 2026-03-31 |
| **GitGraph 詳細パネル修正** | GitGraph の詳細パネルがペイン外にはみ出る問題を修正。パネルの位置計算を改善し、画面端でも正しく収まるよう対応 | [#38](https://github.com/MocA-Love/superset/pull/38) | 2026-03-31 |
| **ConflictViewer 表示・スタイル修正** | ConflictViewer の表示条件とスタイルを修正 | [#38](https://github.com/MocA-Love/superset/pull/38) | 2026-03-31 |
| **ワークスペース切替・レビュー系 UX 強化** | Branch picker の検索・作成導線とブランチ情報表示を改善、blame tooltip に GitHub avatar を追加。ターミナル履歴サジェストの Enter/補完・プレビュー挙動を改善 | [#40](https://github.com/MocA-Love/superset/pull/40) | 2026-03-31 |
| **Review パネル URL ナビゲーション改善** | Review 内のコメント・PR タイトル・Markdown 内リンクを Superset のブラウザタブで新規開くよう統一。既存ブラウザタブの URL 差し替え問題を回避 | [#35](https://github.com/MocA-Love/superset/pull/35) | 2026-03-30 |
| **Problems / Database Explorer / Search 強化** | エディターの問題診断 `Problems` タブを追加し、Workspace 全体の警告・エラーを絞り込み・再取得・該当行ジャンプ可能に。右サイドバーへ Database Explorer と Search（glob/正規表現/置換）を追加 | [#44](https://github.com/MocA-Love/superset/pull/44) | 2026-04-01 |
| **言語診断の多言語対応拡張** | Diagnostics の LSP 基盤を外部 Language Server 化し、YAML / HTML / CSS / Python / Go / Rust / Dockerfile / GraphQL に対応。provider の ON/OFF 切替と runtime materialization を整備 | [#48](https://github.com/MocA-Love/superset/pull/48) | 2026-04-02 |
| **Docker サイドバーと検索・DB設定の大規模追加** | 右サイドバーに Docker ビューを追加してコンテナ/イメージ/ボリュームを管理。Search を木構造・仮想スクロール化し大量件数を高速化。workspace DB 設定の読み書き UI を追加 | [#51](https://github.com/MocA-Love/superset/pull/51) | 2026-04-02 |
| **ブラウザブックマーク管理** | ブックマークのフォルダ作成・ネスト・並び替え、Netscape HTML 形式のインポート/エクスポート、フォルダアイコン・カラー設定 | [#55](https://github.com/MocA-Love/superset/pull/55) | 2026-04-03 |
| **.env / CSV / TSV シンタックスハイライト** | `.env` / `.env.*` ファイルのシンタックスハイライト対応。CSV / TSV は列ごとにテーマカラーをローテーションして表示 | [#64](https://github.com/MocA-Love/superset/pull/64) | 2026-04-04 |
| **HTML ファイルプレビュー** | HTML ファイルをサンドボックス化された webview でレンダリング表示。ズーム操作（+/-/リセット）、リフレッシュボタン、ファイル変更時の自動リロード対応 | [#69](https://github.com/MocA-Love/superset/pull/69) [#77](https://github.com/MocA-Love/superset/pull/77) [#144](https://github.com/MocA-Love/superset/pull/144) | 2026-04-04 |
| **PDF ファイルプレビュー** | Chromium 内蔵の PDF ビューアを webview 経由で利用。ズーム・ページ送り・テキスト検索がそのまま使用可能 | [#70](https://github.com/MocA-Love/superset/pull/70) | 2026-04-04 |
| **GitHub Actions ログビューア** | Review タブの Checks から「View logs」でネイティブログ表示。ジョブ一覧＋ステップ開閉式ログ、ANSI カラー対応、ログ検索、ログコピー（ANSI/タイムスタンプ除去）。Re-run ボタン、リアルタイムポーリング更新 | [#72](https://github.com/MocA-Love/superset/pull/72) [#73](https://github.com/MocA-Love/superset/pull/73) [#122](https://github.com/MocA-Love/superset/pull/122) | 2026-04-04 |
| **Workflow Dispatch UI** | workflow_dispatch の inputs（choice/boolean/string/number）を YAML からパースして UI 表示。ワークフロー実行後はリアルタイムでログに自動遷移 | [#75](https://github.com/MocA-Love/superset/pull/75) | 2026-04-04 |
| **フォークリポジトリ PR 対応** | fork / tracking remote / upstream が混在するリポジトリで PR の向き先候補を自動解決。base repository 選択 UI を追加 | [#71](https://github.com/MocA-Love/superset/pull/71) [#101](https://github.com/MocA-Love/superset/pull/101) | 2026-04-04 |
| **GitHub API 最適化** | 複数ポーリング経路を GitHubSyncService に統合。指数バックオフ付きレートリミッター、アクティブワークスペースのみポーリング（API calls/min: ~75 → ~15） | [#78](https://github.com/MocA-Love/superset/pull/78) [#80](https://github.com/MocA-Love/superset/pull/80) | 2026-04-05 |
| **Docker タブ UX 改善** | コンテナに Rebuild/Delete ボタンとステータス連動コントロールを追加。Database サイドバーをワークスペースごとにスコープ化。Dockerfile 単体プロジェクトでも Docker タブを表示 | [#69](https://github.com/MocA-Love/superset/pull/69) [#76](https://github.com/MocA-Love/superset/pull/76) [#79](https://github.com/MocA-Love/superset/pull/79) | 2026-04-04 |
| **Markdown / シンタックスハイライト強化** | CodeMirror で Lezer の全タグをカバーし VS Code 並のハイライト品質を実現。Markdown の fenced code blocks 内で 19 言語のネスト言語ハイライト対応 | [#90](https://github.com/MocA-Love/superset/pull/90) | 2026-04-06 |
| **VS Code Extension Host Shim** | VS Code 拡張機能ホストシム層を追加（約30 API をシム実装）。Claude Code 拡張の完全なチャット UI 表示・MCP 接続、Codex/ChatGPT 拡張のチャット UI 表示に対応。Webview 配信、Commands、Workspace API 等を実装 | [#91](https://github.com/MocA-Love/superset/pull/91) | 2026-04-06 |
| **インライン自動補完（Inception）** | FIM（Fill-in-the-Middle）を優先し Next Edit をフォールバックに使う補完フロー。Inception usage のローカル集計と設定画面表示。過剰発火の抑制 | [#92](https://github.com/MocA-Love/superset/pull/92) [#132](https://github.com/MocA-Love/superset/pull/132) | 2026-04-06 |
| **vscode.diff コマンド対応** | Codex 拡張の「Review changes」ボタンから Superset の diff viewer を直接開けるよう `vscode.diff` コマンドをシム実装 | [#104](https://github.com/MocA-Love/superset/pull/104) | 2026-04-08 |
| **メモタブ（Memo）** | `.superset/memos/` に保存されるメモを作成可能。Markdown エディタで画像を貼り付けると assets に保存し相対パスを自動挿入。自動保存対応 | [#129](https://github.com/MocA-Love/superset/pull/129) | 2026-04-09 |
| **右サイドバー初期幅設定** | 右サイドバーから開く Files や Changes diff ビューの初期幅を設定で変更可能に | [#130](https://github.com/MocA-Love/superset/pull/130) | 2026-04-09 |
| **リファレンスグラフ** | LSP 基盤を拡張し、シンボルの参照関係・呼び出し階層をインタラクティブなグラフで可視化。@xyflow/react + ELK.js による自動レイアウト、Shiki シンタックスハイライト統合、PNG エクスポート対応。エディタ右クリックから「Show Reference Graph」で起動 | [#147](https://github.com/MocA-Love/superset/pull/147) [#148](https://github.com/MocA-Love/superset/pull/148) | 2026-04-11 |
| **Git 操作ダイアログ統一** | Git 関連エラーとユーザー判断を統一 `GitOperationDialog` に集約。25 種類のエラー自動分類、merge-pr・bulk-stage-all・workflow-dispatch 等の確認ダイアログ、silent auto-repair 通知 | [#153](https://github.com/MocA-Love/superset/pull/153) | 2026-04-12 |
| **UX 改善バッチ** | Clone 進捗のストリーミング表示（プログレスバー＋キャンセル）、Diff Viewer 内検索、タブ切替時の editor state 保持、Git サイドバーの複数選択 stage/unstage（Shift/Cmd+Click）、内蔵ブラウザの Cmd+F 検索 | [#154](https://github.com/MocA-Love/superset/pull/154) | 2026-04-13 |
| **Hover / Go-to-Definition** | エディタで変数・関数にホバーすると Markdown レンダリング対応の型情報・ドキュメントを表示。Shiki ベースのコードブロックハイライト付き。F12 / Cmd+Click / 右クリック「Go to Definition」で定義元にジャンプ。Cmd 押下時にトークンへ下線表示。TypeScript + 外部 LSP 対応 | [#156](https://github.com/MocA-Love/superset/pull/156) [#166](https://github.com/MocA-Love/superset/pull/166) | 2026-04-14 |
| **タブ分割ボタン** | タブツールバーに縦分割・横分割ボタンを追加。ワンクリックでペインを分割可能 | [#155](https://github.com/MocA-Love/superset/pull/155) | 2026-04-14 |
| **安定性・パフォーマンス改善** | LSP language services の安定性修正、拡張機能ホストのメモリリーク修正、ターミナル再表示遅延改善、認証切れ時の無限ループ防止、git status タイムアウト追加、ブラウザリダイレクトループ修正、ポップアウトウィンドウの認証修正、エラーの正規化と Sentry フィルタリング | [#88](https://github.com/MocA-Love/superset/pull/88) [#123](https://github.com/MocA-Love/superset/pull/123) [#121](https://github.com/MocA-Love/superset/pull/121) [#67](https://github.com/MocA-Love/superset/pull/67) [#66](https://github.com/MocA-Love/superset/pull/66) [#158](https://github.com/MocA-Love/superset/pull/158) [#146](https://github.com/MocA-Love/superset/pull/146) [#98](https://github.com/MocA-Love/superset/pull/98) | 2026-04-04〜14 |

## Fork のビルド方法 (macOS)

### 前提条件

- [Bun](https://bun.sh/) v1.0+
- Git 2.20+
- Xcode Command Line Tools (`xcode-select --install`)

### 手順

```bash
# 1. リポジトリをクローン
git clone https://github.com/MocA-Love/superset.git
cd superset

# 2. 依存関係のインストール
bun install

# 3. デスクトップアプリをビルド
cd apps/desktop
SUPERSET_WORKSPACE_NAME=superset bun run build

# 4. ビルド成果物を開く
open release
```

`release` フォルダ内の `.dmg` ファイルを開き、Superset.app を Applications にドラッグしてインストールしてください。

> **⚠️ ビルド時の注意**: `bun dev` でアプリを起動中にビルドすると、開発用の環境変数（`SUPERSET_WORKSPACE_NAME=default` 等）がバイナリに焼き込まれ、本番データ（`~/.superset/`）が参照されなくなります。ビルド時は必ず `SUPERSET_WORKSPACE_NAME=superset` を明示的に指定してください。

> **📦 上書きインストールについて**: 公式版の `.dmg` をフォーク版で上書きしても、ワークスペース・ターミナル履歴・設定はすべて `~/.superset/` に保持されるため、データが消えることはありません。

### 開発モードで実行

```bash
bun install
bun run dev --filter=@superset/desktop
```

---

## Code 10x Faster With No Switching Cost

Superset orchestrates CLI-based coding agents across isolated git worktrees, with built-in terminal, review, and open-in-editor workflows.

- **Run multiple agents simultaneously** without context switching overhead
- **Isolate each task** in its own git worktree so agents don't interfere with each other
- **Monitor all your agents** from one place and get notified when they need attention
- **Review and edit changes quickly** with the built-in diff viewer and editor
- **Open any workspace where you need it** with one-click handoff to your editor or terminal

Wait less, ship more.

## Features

| Feature | Description |
|:--------|:------------|
| **Parallel Execution** | Run 10+ coding agents simultaneously on your machine |
| **Worktree Isolation** | Each task gets its own branch and working directory |
| **Agent Monitoring** | Track agent status and get notified when changes are ready |
| **Built-in Diff Viewer** | Inspect and edit agent changes without leaving the app |
| **Workspace Presets** | Automate env setup, dependency installation, and more |
| **Universal Compatibility** | Works with any CLI agent that runs in a terminal |
| **Quick Context Switching** | Jump between tasks as they need your attention |
| **IDE Integration** | Open any workspace in your favorite editor with one click |

## Supported Agents

Superset works with any CLI-based coding agent, including:

| Agent | Status |
|:------|:-------|
| [Amp Code](https://ampcode.com/) | Fully supported |
| [Claude Code](https://github.com/anthropics/claude-code) | Fully supported |
| [OpenAI Codex CLI](https://github.com/openai/codex) | Fully supported |
| [Cursor Agent](https://docs.cursor.com/agent) | Fully supported |
| [Gemini CLI](https://github.com/google-gemini/gemini-cli) | Fully supported |
| [GitHub Copilot](https://github.com/features/copilot) | Fully supported |
| [OpenCode](https://github.com/opencode-ai/opencode) | Fully supported |
| [Pi](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent) | Fully supported |
| Any CLI agent | Will work |

If it runs in a terminal, it runs on Superset

## Requirements

| Requirement | Details |
|:------------|:--------|
| **OS** | macOS (Windows/Linux untested) |
| **Runtime** | [Bun](https://bun.sh/) v1.0+ |
| **Version Control** | Git 2.20+ |
| **GitHub CLI** | [gh](https://cli.github.com/) |
| **Caddy** | [caddy](https://caddyserver.com/docs/install) (for dev server) |

## Getting Started

### Quick Start (Pre-built)

**[Download Superset for macOS](https://github.com/superset-sh/superset/releases/latest)**

### Build from Source

<details>
<summary>Click to expand build instructions</summary>

**1. Clone the repository**

```bash
git clone https://github.com/superset-sh/superset.git
cd superset
```

**2. Set up environment variables** (choose one):

Option A: Full setup
```bash
cp .env.example .env
# Edit .env and fill in the values
```

Option B: Skip env validation (for quick local testing)
```bash
cp .env.example .env
echo 'SKIP_ENV_VALIDATION=1' >> .env
```

**3. Set up Caddy** (reverse proxy for Electric SQL streams):

```bash
# Install caddy: brew install caddy (macOS) or see https://caddyserver.com/docs/install
cp Caddyfile.example Caddyfile
```

**4. Install dependencies and run**

```bash
bun install
bun run dev
```

**5. Build the desktop app**

```bash
bun run build
open apps/desktop/release
```

</details>

## Keyboard Shortcuts

All shortcuts are customizable via **Settings > Keyboard Shortcuts** (`⌘/`). See [full documentation](https://docs.superset.sh/keyboard-shortcuts).

### Workspace Navigation

| Shortcut | Action |
|:---------|:-------|
| `⌘1-9` | Switch to workspace 1-9 |
| `⌘⌥↑/↓` | Previous/next workspace |
| `⌘N` | New workspace |
| `⌘⇧N` | Quick create workspace |
| `⌘⇧O` | Open project |

### Terminal

| Shortcut | Action |
|:---------|:-------|
| `⌘T` | New tab |
| `⌘W` | Close pane/terminal |
| `⌘D` | Split right |
| `⌘⇧D` | Split down |
| `⌘K` | Clear terminal |
| `⌘F` | Find in terminal |
| `⌘⌥←/→` | Previous/next tab |
| `Ctrl+1-9` | Open preset 1-9 |

### Layout

| Shortcut | Action |
|:---------|:-------|
| `⌘B` | Toggle workspaces sidebar |
| `⌘L` | Toggle changes panel |
| `⌘O` | Open in external app |
| `⌘⇧C` | Copy path |

## Configuration

Configure workspace setup and teardown in `.superset/config.json`. See [full documentation](https://docs.superset.sh/setup-teardown-scripts).

```json
{
  "setup": ["./.superset/setup.sh"],
  "teardown": ["./.superset/teardown.sh"]
}
```

| Option | Type | Description |
|:-------|:-----|:------------|
| `setup` | `string[]` | Commands to run when creating a workspace |
| `teardown` | `string[]` | Commands to run when deleting a workspace |

### Example setup script

```bash
#!/bin/bash
# .superset/setup.sh

# Copy environment variables
cp ../.env .env

# Install dependencies
bun install

# Run any other setup tasks
echo "Workspace ready!"
```

Scripts have access to environment variables:
- `SUPERSET_WORKSPACE_NAME` — Name of the workspace
- `SUPERSET_ROOT_PATH` — Path to the main repository

## Mastra Dependencies

This repo uses the published upstream `mastracode` and `@mastra/*` packages directly. Avoid adding custom tarball overrides unless there is a repo-specific blocker.

## Tech Stack

<p>
  <a href="https://www.electronjs.org/"><img src="https://img.shields.io/badge/Electron-191970?logo=Electron&logoColor=white" alt="Electron" /></a>
  <a href="https://reactjs.org/"><img src="https://img.shields.io/badge/React-%2320232a.svg?logo=react&logoColor=%2361DAFB" alt="React" /></a>
  <a href="https://tailwindcss.com/"><img src="https://img.shields.io/badge/Tailwindcss-%2338B2AC.svg?logo=tailwind-css&logoColor=white" alt="TailwindCSS" /></a>
  <a href="https://bun.sh/"><img src="https://img.shields.io/badge/Bun-000000?logo=bun&logoColor=white" alt="Bun" /></a>
  <a href="https://turbo.build/"><img src="https://img.shields.io/badge/Turborepo-EF4444?logo=turborepo&logoColor=white" alt="Turborepo" /></a>
  <a href="https://vitejs.dev/"><img src="https://img.shields.io/badge/Vite-%23646CFF.svg?logo=vite&logoColor=white" alt="Vite" /></a>
  <a href="https://biomejs.dev/"><img src="https://img.shields.io/badge/Biome-339AF0?logo=biome&logoColor=white" alt="Biome" /></a>
  <a href="https://orm.drizzle.team/"><img src="https://img.shields.io/badge/Drizzle%20ORM-FFE873?logo=drizzle&logoColor=black" alt="Drizzle ORM" /></a>
  <a href="https://neon.tech/"><img src="https://img.shields.io/badge/Neon-00E9CA?logo=neon&logoColor=white" alt="Neon" /></a>
  <a href="https://trpc.io/"><img src="https://img.shields.io/badge/tRPC-2596BE?logo=trpc&logoColor=white" alt="tRPC" /></a>
</p>

## Private by Default

- **Source Available** — Full source is available on GitHub under Elastic License 2.0 (ELv2).
- **Explicit Connections** — You choose which agents, providers, and integrations to connect.

## Contributing

We welcome contributions! If you have a suggestion that would make Superset better:

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

You can also [open issues](https://github.com/superset-sh/superset/issues) for bugs or feature requests.

See [CONTRIBUTING.md](CONTRIBUTING.md) for detailed instructions and code of conduct.

<a href="https://github.com/superset-sh/superset/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=superset-sh/superset" />
</a>

## Community

Join the Superset community to get help, share feedback, and connect with other users:

- **[Discord](https://discord.gg/cZeD9WYcV7)** — Chat with the team and community
- **[Twitter](https://x.com/superset_sh)** — Follow for updates and announcements
- **[GitHub Issues](https://github.com/superset-sh/superset/issues)** — Report bugs and request features
- **[GitHub Discussions](https://github.com/superset-sh/superset/discussions)** — Ask questions and share ideas

### Team

[![Avi Twitter](https://img.shields.io/badge/Avi-@avimakesrobots-555?logo=x)](https://x.com/avimakesrobots)
[![Kiet Twitter](https://img.shields.io/badge/Kiet-@flyakiet-555?logo=x)](https://x.com/flyakiet)
[![Satya Twitter](https://img.shields.io/badge/Satya-@saddle__paddle-555?logo=x)](https://x.com/saddle_paddle)

## License

Distributed under the Elastic License 2.0 (ELv2). See [LICENSE.md](LICENSE.md) for more information.
