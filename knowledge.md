# Desktop terminal instability with Codex CLI

最終更新: 2026-04-22

## 背景

`apps/desktop` のターミナルで Codex CLI を使っていると、回答生成中や回答直後の描画が不安定になることがあった。特に「回答本文だけ少し揺れる」「応答後の表示が崩れやすい」「分割リサイズ後に不安定さが増す」といった症状が出ていた。

今回の対応では、単なる描画ノイズではなく、以下の 2 系統が重なっていた可能性が高い。

1. ターミナルの attach / resize 周りの不安定さ
2. renderer 側 xterm が端末問い合わせに反応し、PTY に重複レスポンスを返していた問題

## 典型的な症状

- Codex の回答中だけ表示が揺れる
- 回答が返ってきた直後の本文部分だけ不安定になる
- pane のサイズ変更後に表示崩れが起きやすくなる
- ログ上で `route-event-to-handler` と `resize-observer` が大量に出る
- `renderer-to-pty` に terminal query response が流れている

## ログを見るときの判断基準

### 危険信号

以下は今回の不安定化と強く相関していた。

- `renderer-to-pty` で `CSI ... R` が出る
  - 例: `hex: '1b 5b 32 39 3b 33 52'`
  - これは CPR (`ESC [ row ; col R`) で、renderer 側 xterm が端末問い合わせへ返答してしまっているサイン
- `renderer-to-pty` に DA / DSR / OSC query 由来の応答が混ざる
- 回答レンダリングのタイミングで上記応答が連続する

### すぐに異常扱いしなくてよいもの

- `renderer-to-pty` の `hex: '1b 5b 49'`
  - Focus In (`ESC [ I`)
- `renderer-to-pty` の `hex: '1b 5b 4f'`
  - Focus Out (`ESC [ O`)
- `route-event-to-handler` の小さな chunk
  - 例: `dataBytes: 4`, `18`, `141`, `355`
  - TUI の差分描画だけでも普通に出る
- `resize-observer` / `resize:mutate` / `resize:trpc`
  - pane サイズ変更と対応していれば自然
- macOS / Electron の以下の warning
  - `representedObject is not a WeakPtrToElectronMenuModelAsNSObject`
  - 今回の範囲では terminal 描画不安定化の主因には見えなかった

## 今回効いた対策

### 1. hidden tab stack の見直しは有効だったが、現時点では採用していない

hidden の `TabView` を積んだまま persistent に保持すると、見えていない terminal が裏でぶら下がり続け、描画破損や状態競合の温床になりやすい。

試したこと:

- `PersistentTabRenderer` の利用をやめる
- `TabsContent` では active tab の `TabView` のみ描画する

観測:

- offscreen terminal の干渉を減らせる
- upstream の修正方針とも一致する

ただし、この変更は別の UX / 状態保持回帰を招いたため、最終的には revert した。現行コードでは `PersistentTabRenderer` を使っている。

### 2. resize 処理を複雑化しすぎない

rows 即時反映、cols debounce、`proposeDimensions()`、手動 `xterm.resize()` のような独自パスは、一見丁寧でも不安定化要因になりやすい。

対応:

- `ResizeObserver` でコンテナサイズを監視
- `fitAddon.fit()` を素直に呼ぶ
- 反映後の `cols/rows` が本当に変わった時だけ `onResize` を呼ぶ

効果:

- splitter 操作時の揺れが減る
- resize 経路が単純になり、ログの解釈もしやすくなる

### 3. terminal query response を renderer から PTY に返さない

Codex CLI 系の TUI では terminal query が多く、renderer 側 xterm がそれに自動応答し、その応答が PTY に戻ると相互作用が壊れやすい。

今回特に重要だったのは `CSI ... R` の抑止。

対応:

- 既存の response suppression を拡張
- response だけでなく query 自体も抑止対象に追加
- 少なくとも以下を抑止対象に含める
  - `CSI c`
  - `CSI > c`
  - `CSI = c`
  - `CSI n`
  - `CSI ? n`
  - `OSC 4/10/11/12` の query 形式
  - `CSI R`
  - `CSI I`
  - `CSI O`
  - `CSI $y`

効果:

- `renderer-to-pty` の CPR 応答が消えた
- 回答本文付近の不安定さが大きく改善した

### 4. `xterm.open()` は live DOM に attach してから 1 回だけ呼ぶ

detached な wrapper に対して先に `xterm.open()` すると、初期描画や texture atlas 初期化が不安定になることがある。

対応:

- terminal 作成時は wrapper だけ用意する
- `appendChild()` で live DOM に attach した直後に `openOnce()` を呼ぶ
- `open()` の多重実行はガードする

効果:

- 初回描画と応答直後の表示が安定しやすくなる

## 今回変更した箇所

- `apps/desktop/src/renderer/screens/main/components/WorkspaceView/ContentView/TabsContent/Terminal/v1-terminal-cache.ts`
  - resize 経路の単純化
  - attach 後 `openOnce()` 呼び出し
- `apps/desktop/src/renderer/screens/main/components/WorkspaceView/ContentView/TabsContent/Terminal/suppressQueryResponses.ts`
  - query / response の抑止対象を拡張
- `apps/desktop/src/renderer/screens/main/components/WorkspaceView/ContentView/TabsContent/Terminal/helpers.ts`
  - detached open をやめ、attach 後 open に変更

試して戻したもの:

- `apps/desktop/src/renderer/screens/main/components/WorkspaceView/ContentView/TabsContent/index.tsx`
  - active tab のみ描画
  - offscreen terminal 干渉の切り分けには有効だったが、現時点では未採用

## upstream 追跡上のメモ

今回の方向性は upstream の過去対応と整合している。

- hidden な mosaic / tab stack を避ける方針
- v1 terminal でも hide-attach 系の安定化を取り込む流れ
- duplicate terminal query response が interactive CLI を壊すという既知問題

つまり、fork 独自の複雑化より upstream に近づける方が安定しやすい。

## 再発時の切り分け手順

1. まず `renderer-to-pty` を確認する
2. `CSI ... R` が出ていないかを見る
3. 出ているなら query suppression の退行を疑う
4. 出ていないなら `resize-observer` と pane リサイズ操作の相関を見る
5. hidden terminal を再導入していないか確認する
6. `xterm.open()` が detached DOM で呼ばれていないか確認する
7. Electron の menu warning は一旦 terminal 問題と切り離して考える

## 運用メモ

- この問題は「完全にゼロになった」より「再発しにくい構成に寄せた」と考えるべき
- 症状が再発した場合、最初に疑うべきは renderer-to-pty の query response 退行
- その次に疑うべきは hidden terminal の復活と独自 resize ロジックの再肥大化
- terminal 周りは、安定性を優先するなら upstream に近いほど安全
