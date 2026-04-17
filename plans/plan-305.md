# Issue #305: ティアオフウィンドウでメニューイベントを処理しない

## 概要

ティアオフ（切り離し）ウィンドウを開いている状態で、メインウィンドウからメニューで Settings を開くと、ティアオフウィンドウまで Settings 画面に遷移してしまう。
同様の構造で `open-workspace` や `browser-action` も全ウィンドウでハンドリングされ、ティアオフ側で誤作動する可能性がある。

## 原因

`apps/desktop/src/renderer/routes/_authenticated/layout.tsx:136-147` の `electronTrpc.menu.subscribe` がメイン/ティアオフ問わず全ウィンドウで購読されているため、main 側の `menuEmitter.emit(...)` が全ウィンドウにブロードキャストされる。

## 修正方針

`menu.subscribe` の `onData` 冒頭で `isTearoffWindow()` ガードを入れ、ティアオフウィンドウではメニュー由来のイベントを処理しない。

- `open-settings` / `open-workspace` / `browser-action` のいずれもメインウィンドウのみで処理されるべき操作
- 最小差分で副作用なく修正できる

## 変更対象ファイル

- `apps/desktop/src/renderer/routes/_authenticated/layout.tsx`
  - `menu.subscribe` の `onData` 先頭に `isTearoffWindow()` ガードを追加
  - `useTearoffInit` から `isTearoffWindow` を import

## 影響範囲

- ティアオフウィンドウでメニュー由来のイベントを受け取らなくなる（期待動作）
- メインウィンドウの挙動は変更なし

## 受け入れ条件

- ティアオフ表示中にメイン側で Settings を開く → メインのみ遷移し、ティアオフ側は現在のタブ表示を維持
- `open-workspace` / `browser-action` も同様にメインのみで処理
