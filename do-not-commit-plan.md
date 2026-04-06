# Next Edit (Inception) 補完機能 実装計画

## 目的
Superset Desktop の設定画面で、エディタ補完（Next Edit）を有効化し、APIキー入力と補完制御パラメータを管理できるようにする。

## 方針
- 設定画面の導線は既存 `models` セクションに統一して追加。
- 既存のモデルプロバイダ設定（Anthropic/OpenAI）と同じ UX と保存フローに寄せる。
- APIキーは `api-keys` セクションではなく、`/settings/models` 配下へ追加。
- 初期版は「使えることを優先し、必要最小の設定項目」から開始し、将来拡張しやすい構造にする。

## 実装対象
- `apps/desktop/src/renderer/routes/_authenticated/settings/models/page.tsx`
- `apps/desktop/src/renderer/routes/_authenticated/settings/models/components/ModelsSettings/ModelsSettings.tsx`
- `apps/desktop/src/renderer/stores/settings-state.ts`
- `apps/desktop/src/renderer/routes/_authenticated/settings/components/SettingsSidebar/GeneralSettings.tsx`
- `apps/desktop/src/renderer/routes/_authenticated/settings/utils/settings-search/settings-search.ts`
- `apps/desktop/src/lib/trpc/routers/settings/index.ts`
- `packages/chat/src/server/desktop/router/router.ts` と `packages/chat/src/server/desktop/auth/*`（または現行実装に準拠する永続化ポイント）

> 注: 既存実装の保存仕様と命名規則に寄せる。`settings` 側か `chatService` 側かで実装差が出るため、まずは既存の `ModelsSettings` と `chatService.auth.*` の連携パターンをそのまま利用する。

## 設定項目（MVP）
1. `Next Edit API Key`
- マスク付き入力（表示切替有）
- 空欄時は「未設定」表示

2. `次編集（補完）を有効化`
- トグル
- OFF時は補完呼び出しを一切しない

3. `max_tokens`
- 数値入力（例: 256〜2048）
- 初期値: 1024

4. `temperature`
- 数値入力（0.0〜1.0）
- 初期値: 0.3

5. `top_p`
- 数値入力（0.0〜1.0）
- 初期値: 0.8

6. `presence_penalty`
- 数値入力（-2.0〜2.0）
- 初期値: 1.0

7. `stop`
- 任意文字列（2〜3個程度まで、将来拡張）

## 将来拡張（v2候補）
- `model`
- `request_debounce_ms`
- `recent_snippets_count`
- `edit_history_depth`
- `timeout_ms`

## 作業ステップ
1. 設計確定
- Next Edit 有効化時のデータフロー確認
  - キー取得先（設定保存場所）
  - 呼び出し経路（編集トリガー→バックエンド）
- UIラベルと型の最終確定

2. バックエンド設定保存の追加
- Next Edit向け保存キー追加（既存命名ルール準拠）
- get/set RPC または既存auth APIの拡張
- バリデーション（数値範囲/型）追加
- デフォルト値を定義し、未設定時のフォールバックを明示

3. 設定UI実装
- `ModelsSettings` に「Next Edit」カード/セクションを追加
- APIキーとON/OFFを最上位に置く
- パラメータは「基本」「高度（任意）」2段構成で可読性担保
- 保存ボタンは既存パターンに合わせる

4. 検索/遷移の整合
- 設定検索indexへ項目追加（Next Edit関連ワード）
- サイドバー表示名の更新（既存 `models` セクション内の表示文言）

5. 動作連携
- 送信payloadが Next Edit API 仕様に一致することを確認
- ON/OFFで呼び出しをガード
- 禁止値・負値・空文字の受け入れ条件を実装

6. フェイルセーフ・安全性
- APIキーは非表示保存/表示
- 保存失敗時の明示的エラー表示
- 取得失敗時の既定値復元

7. 最終確認（実装者が実行）
- 設定保存→再起動で反映
- 補完ON/OFF切替
- APIキー有効性エラー時の表示

## 実装上の保存設計（推奨）
- `models` 設定と同じ責務で管理し、次の命名を採用:
  - `nextEditEnabled`
  - `nextEditMaxTokens`
  - `nextEditTemperature`
  - `nextEditTopP`
  - `nextEditPresencePenalty`
  - `nextEditStopTokens`
  - `nextEditApiKey`
- 型は zod または同等の既存バリデータで一元化

## 受け入れ基準
- `/settings/models` に「Next Edit」設定が追加される
- APIキー保存・取得・再表示が可能
- トグルOFF時は補完呼び出しが停止する
- 主要パラメータ（max_tokens/temperature/top_p/presence_penalty）が反映される
- 既存 `models` 設定（Anthropic/OpenAI）への影響がない

## 段取り目安（実装時間）
- 0.5日: 仕様確定＋保存設計
- 1.0日: バックエンド保存と型追加
- 1.0日: UI実装・バリデーション・エラーハンドリング
- 0.5日: 設定検索/UX調整・最終結線

## リスク
- Next Edit endpoint 仕様変更（APIパラメータ名/型）
- APIキー保管方針（暗号化/環境変数連携）の揺れ
- 既存settings state更新と競合する場合のmerge不整合
