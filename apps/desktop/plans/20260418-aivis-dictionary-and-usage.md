# Aivis: ユーザー辞書 & 日別使用量ダッシュボード

作成日: 2026-04-18
関連 Issue: #286 (Aivis 音声読み上げ機能の拡張)
関連 PR: #287 (Aivis 通知のベース実装)

## 背景

PR #287 で Aivis API による音声読み上げ通知を実装済み。次のステップとして、開発者向けに刺さりそうな以下 2 機能を追加する。

1. **ユーザー辞書**: ブランチ名・プロジェクト名・英略語など特殊な読み方をする単語をカスタム登録し、音声合成に反映する
2. **日別使用量ダッシュボード**: Aivis の API 使用状況 (リクエスト数・文字数・クレジット消費) を日別に可視化する

どちらも Settings > Notifications > Aivis セクション内に配置する。

## API 前提

### ユーザー辞書

| Method | Path | 用途 |
|---|---|---|
| GET | `/v1/user-dictionaries` | 辞書一覧 (uuid, name, description, word_count, created_at, updated_at) |
| GET | `/v1/user-dictionaries/{uuid}` | 辞書詳細 (word_properties 配列まで含む) |
| PUT | `/v1/user-dictionaries/{uuid}` | 辞書を丸ごと置き換え (作成・更新共通) |
| DELETE | `/v1/user-dictionaries/{uuid}` | 辞書削除 |
| POST | `/v1/user-dictionaries/{uuid}/import?override=true\|false` | AivisSpeech 互換 JSON を取り込み |
| GET | `/v1/user-dictionaries/{uuid}/export` | AivisSpeech 互換 JSON を出力 |

**WordProperty フィールド**:

```ts
{
  uuid: string;          // クライアント側で UUID v4 を採番
  surface: string[];     // 表記 (配列) 例: ["Superset", "superset"]
  normalized_surface: string[] | null;
  pronunciation: string[]; // カタカナ読み 例: ["スーパーセット"]
  accent_type: number[]; // アクセント核位置 (0 始まり)。不明なら 0
  word_type: "PROPER_NOUN" | "COMMON_NOUN" | "VERB" | "ADJECTIVE" | "SUFFIX"; // デフォルト PROPER_NOUN
  priority: number;      // 0-10、デフォルト 5
}
```

**合成時の指定**: `POST /v1/tts/synthesize` のボディに `user_dictionary_uuid` (単一 uuid、オプション) を載せる。**複数辞書指定は不可**。

### 使用量サマリ

| Method | Path |
|---|---|
| GET | `/v1/payment/usage-summaries?start_date=YYYY-MM-DD&end_date=YYYY-MM-DD` |

**レスポンス (1 行 = 1 時間 × 1 API キー)**:

```ts
{
  summaries: Array<{
    api_key_id: string;
    api_key_name: string;
    summary_date: string; // YYYY-MM-DD
    summary_hour: number; // 0-23
    request_count: number;
    character_count: number;
    credit_consumed: number;
  }>;
}
```

日別グラフ化はクライアント側で `summary_date` ごとに集計する。API キーが複数ある場合もまとめて合算 (オプションでキー別表示)。

## 実装方針

### 全体構成

- Aivis API 呼び出しは main プロセスに集約 (API キーを renderer に流さない)
  - 新規: `apps/desktop/src/main/lib/aivis/client.ts` — 汎用の authorized fetch ラッパー
  - 新規: `apps/desktop/src/main/lib/aivis/dictionary.ts` — 辞書 CRUD
  - 新規: `apps/desktop/src/main/lib/aivis/usage.ts` — 使用量取得 + 日別集計
- TRPC `aivis` サブルーターを新設: `apps/desktop/src/lib/trpc/routers/aivis/index.ts`
  - 既存の `settings.testAivisPlayback` もこちらに移植 (移植は別PRでも可)
  - すべて API キーは main で DB から読み取るため、renderer からは引数不要
- 既存の settings に `aivisUserDictionaryUuid` (text) を追加し、合成時に載せる

### ステップ 1: API クライアント

`apps/desktop/src/main/lib/aivis/client.ts`:

```ts
const BASE = "https://api.aivis-project.com";

function readApiKey(): string | null {
  const row = localDb.select().from(settings).get();
  return row?.aivisApiKey || null;
}

export async function aivisFetch(
  path: string,
  init: RequestInit & { query?: Record<string, string | undefined> } = {},
): Promise<Response> {
  const key = readApiKey();
  if (!key) throw new Error("Aivis API key is not configured");
  const url = new URL(path, BASE);
  for (const [k, v] of Object.entries(init.query ?? {})) {
    if (v !== undefined) url.searchParams.set(k, v);
  }
  const res = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${key}`,
      Accept: "application/json",
      ...(init.body && !(init.body instanceof FormData)
        ? { "Content-Type": "application/json" }
        : {}),
      ...init.headers,
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Aivis ${res.status}: ${body.slice(0, 300)}`);
  }
  return res;
}
```

### ステップ 2: DB スキーマ

`packages/local-db/src/schema/schema.ts` の settings テーブルに追加:

- `aivisUserDictionaryUuid: text("aivis_user_dictionary_uuid")` — 合成時に適用する辞書 UUID

マイグレーション自動生成: `bun run generate --name="add_aivis_user_dictionary_uuid"`

### ステップ 3: 辞書 TRPC ルーター

`apps/desktop/src/lib/trpc/routers/aivis/dictionary.ts`:

```ts
export const aivisDictionaryRouter = router({
  list: publicProcedure.query(async () => {
    const res = await aivisFetch("/v1/user-dictionaries");
    const json = await res.json();
    return json.user_dictionaries as Array<{
      uuid: string;
      name: string;
      description: string;
      word_count: number;
      updated_at: string;
    }>;
  }),

  get: publicProcedure.input(z.object({ uuid: z.string().uuid() }))
    .query(async ({ input }) => {
      const res = await aivisFetch(`/v1/user-dictionaries/${input.uuid}`);
      return await res.json();
    }),

  upsert: publicProcedure.input(z.object({
    uuid: z.string().uuid(),           // 新規作成時は crypto.randomUUID()
    name: z.string().max(100),
    description: z.string().max(500).default(""),
    words: z.array(z.object({
      uuid: z.string().uuid(),
      surface: z.array(z.string().min(1)).min(1),
      pronunciation: z.array(z.string().min(1)).min(1),
      accent_type: z.array(z.number().int().min(0)),
      word_type: z.enum(["PROPER_NOUN","COMMON_NOUN","VERB","ADJECTIVE","SUFFIX"]).default("PROPER_NOUN"),
      priority: z.number().int().min(0).max(10).default(5),
    })),
  })).mutation(async ({ input }) => {
    await aivisFetch(`/v1/user-dictionaries/${input.uuid}`, {
      method: "PUT",
      body: JSON.stringify({
        name: input.name,
        description: input.description,
        word_properties: input.words,
      }),
    });
    return { success: true };
  }),

  delete: publicProcedure.input(z.object({ uuid: z.string().uuid() }))
    .mutation(async ({ input }) => {
      await aivisFetch(`/v1/user-dictionaries/${input.uuid}`, { method: "DELETE" });
      return { success: true };
    }),

  export: publicProcedure.input(z.object({ uuid: z.string().uuid() }))
    .query(async ({ input }) => {
      const res = await aivisFetch(`/v1/user-dictionaries/${input.uuid}/export`);
      return await res.json(); // AivisSpeech 互換 Object
    }),

  import: publicProcedure.input(z.object({
    uuid: z.string().uuid(),
    data: z.record(z.string(), z.unknown()), // AivisSpeech 互換
    override: z.boolean().default(false),
  })).mutation(async ({ input }) => {
    await aivisFetch(`/v1/user-dictionaries/${input.uuid}/import`, {
      method: "POST",
      query: { override: String(input.override) },
      body: JSON.stringify(input.data),
    });
    return { success: true };
  }),
});
```

### ステップ 4: 合成呼び出しに辞書 UUID を付与

`apps/desktop/src/main/lib/notifications/aivis-tts.ts` を拡張:

- `readAivisSettings()` に `userDictionaryUuid` を追加
- `synthesize()` が受け取り、リクエストボディに `user_dictionary_uuid` を積む
- `playAivisTts` オプションにも `userDictionaryUuid?: string` を追加

### ステップ 5: 使用量サマリルーター

`apps/desktop/src/lib/trpc/routers/aivis/usage.ts`:

```ts
export const aivisUsageRouter = router({
  daily: publicProcedure.input(z.object({
    startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  })).query(async ({ input }) => {
    const res = await aivisFetch("/v1/payment/usage-summaries", {
      query: { start_date: input.startDate, end_date: input.endDate },
    });
    const { summaries } = await res.json();

    // summary_date で集計
    const byDate = new Map<string, {
      date: string;
      requestCount: number;
      characterCount: number;
      creditConsumed: number;
      byApiKey: Record<string, { name: string; requestCount: number; characterCount: number; creditConsumed: number }>;
    }>();
    for (const s of summaries) {
      const entry = byDate.get(s.summary_date) ?? {
        date: s.summary_date,
        requestCount: 0, characterCount: 0, creditConsumed: 0,
        byApiKey: {},
      };
      entry.requestCount += s.request_count;
      entry.characterCount += s.character_count;
      entry.creditConsumed += s.credit_consumed;
      const bucket = entry.byApiKey[s.api_key_id] ?? {
        name: s.api_key_name, requestCount: 0, characterCount: 0, creditConsumed: 0,
      };
      bucket.requestCount += s.request_count;
      bucket.characterCount += s.character_count;
      bucket.creditConsumed += s.credit_consumed;
      entry.byApiKey[s.api_key_id] = bucket;
      byDate.set(s.summary_date, entry);
    }

    return {
      days: [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date)),
      total: {
        requestCount: [...byDate.values()].reduce((a, b) => a + b.requestCount, 0),
        characterCount: [...byDate.values()].reduce((a, b) => a + b.characterCount, 0),
        creditConsumed: [...byDate.values()].reduce((a, b) => a + b.creditConsumed, 0),
      },
    };
  }),
});
```

### ステップ 6: 辞書 UI

配置: `apps/desktop/src/renderer/routes/_authenticated/settings/ringtones/components/AivisDictionary/`

- 辞書リスト (name / word_count / 更新日)
- 辞書の新規作成 (name 入力 → crypto.randomUUID でローカル採番して upsert)
- 辞書選択 (ラジオ) → settings.aivisUserDictionaryUuid に保存
- 辞書編集モーダル:
  - 表形式で `surface / pronunciation / accent_type / priority` を編集
  - 行追加 / 削除 / 並べ替え
  - accent_type は数値スピナー、word_type は select、priority は 0-10 スライダ
- エクスポート (ダウンロード) / インポート (JSON ファイル選択)
- 削除ボタン (確認ダイアログ)

**バリデーション注意点**:
- `surface` / `pronunciation` は空配列不可、空文字の要素不可
- `accent_type` が空なら 0 を自動補完
- pronunciation はカタカナのみに制限 (正規表現 `/^[\u30A0-\u30FFー]+$/`)

### ステップ 7: 使用量ダッシュボード UI

配置: `apps/desktop/src/renderer/routes/_authenticated/settings/ringtones/components/AivisUsage/`

- 期間選択 (直近 7 日 / 30 日 / カスタム)
- 合計バー (リクエスト / 文字数 / クレジット)
- 日別棒グラフ (シンプルに CSS で作るか、既に入っていれば recharts を利用)
  - y 軸: クレジット消費 (既定)。トグルで request_count / character_count に切替
- 日別テーブル (日付 / リクエスト / 文字数 / クレジット)
- API キーが複数ある場合のみ「キー別内訳」アコーディオン

**依存追加の判断**:
- 既に `recharts` / `visx` / `chart.js` 等が入っていれば流用
- なければ最初はシンプルな CSS バーで十分 (過剰依存を避ける)

## タスク分解

1. local-db: `aivisUserDictionaryUuid` 追加 + migration 生成
2. main: `aivis/client.ts` 追加 (authorized fetch)
3. main: `aivis/dictionary.ts` (ラッパ)、`aivis/usage.ts` (集計ロジック) 追加
4. TRPC: `aivis` サブルーター (dictionary + usage) を登録
5. main: `aivis-tts.ts` に `user_dictionary_uuid` を付与するよう拡張
6. settings: `getAivisSettings`/`setAivisSettings` に `userDictionaryUuid` を追加
7. UI: AivisDictionary (一覧 + 編集モーダル + import/export)
8. UI: AivisUsage (期間選択 + グラフ + テーブル)
9. 既存 AivisSettings に辞書セレクタを追加
10. Settings 検索に辞書/使用量アイテムを追加
11. typecheck / lint / 実機動作確認

## リスク・論点

- **API レート/クレジット消費**: 使用量グラフの描画で `usage-summaries` を頻繁に叩かない (フォーカス時のみ or 手動更新)。キャッシュ TTL 5 分程度。
- **エラー表示**: Aivis 401 (キー無効) 時に UI 全体を無効化するか、辞書/使用量だけエラー表示にするか。後者推奨。
- **辞書 UI の複雑度**: アクセント型の編集は UX が難しい。MVP では数値入力で十分。将来的に実音声プレビュー + アクセントビジュアライザを検討。
- **複数 API キー**: Aivis 側でキー切替・失効管理が可能。今は単一キー前提だが、将来的には複数キーに拡張できる設計にする (`api_key_id` で集計済み)。
- **辞書の単語上限**: API ドキュメントに明示上限なし。数千行になるケースを想定し、テーブル UI は仮想スクロールを検討。

## 段階リリース案

- **Phase 1** (この PR): 辞書 CRUD (最小限の UI) + 合成時適用
- **Phase 2** (続く PR): 使用量ダッシュボード
- **Phase 3** (余力): 辞書エディタの UX 強化 (音声プレビュー、アクセントビジュアル)

Phase 1 と 2 は独立しているため、同時に PR を分けて進めても良い。

## 完了条件

- [ ] 辞書を作成・編集・削除できる
- [ ] 作成した辞書を通知音声合成に適用できる (固有名詞が期待通り読まれる)
- [ ] AivisSpeech 互換 JSON の import/export が動作
- [ ] 日別使用量を直近 7 日 / 30 日で表示できる
- [ ] API キー未設定時は適切な誘導が出る
- [ ] typecheck / lint / 既存テスト がすべて緑
