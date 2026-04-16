# Issue #185: Vibrancy ON時にダイアログ背景が透過する問題

## 概要
デスクトップアプリでVibrancy(透過)をONにすると、ダイアログ/モーダルの背景まで透過してしまい内容が見づらくなるバグの修正。

## 根本原因
- `globals.css` で `data-vibrancy="on"` 時に `--background` が `rgba(21, 17, 16, 0.6)` に設定される
- `dialog.tsx` 等のモーダルコンポーネントは `bg-background` を使用しており、そのまま透過色が適用される
- `--popover` は `0.95` と適切な不透明度だが、モーダル系は使っていない

## 修正方針: CSS側で data-slot セレクタを使用

`apps/desktop/src/renderer/globals.css` のvibrancyセクションに、モーダル系コンポーネントの背景を不透明にするルールを追加する。

### 変更ファイル
- `apps/desktop/src/renderer/globals.css` のみ

### 変更内容
vibrancy ON時に以下の `data-slot` を持つ要素の背景色を `--popover`（不透明度0.95）相当にオーバーライド:
- `[data-slot="dialog-content"]`
- `[data-slot="alert-dialog-content"]`
- `[data-slot="sheet-content"]`
- `[data-slot="drawer-content"]`

```css
:root[data-vibrancy="on"] [data-slot="dialog-content"],
:root[data-vibrancy="on"] [data-slot="alert-dialog-content"],
:root[data-vibrancy="on"] [data-slot="sheet-content"],
:root[data-vibrancy="on"] [data-slot="drawer-content"] {
    background-color: var(--popover);
}
```

ライトモード用のルールも同様に追加。

### メリット
- `packages/ui`（共有パッケージ）を変更しない
- デスクトップアプリ固有のCSSで完結
- `--popover` は既に適切な不透明度(0.95)が設定されているので再利用できる
