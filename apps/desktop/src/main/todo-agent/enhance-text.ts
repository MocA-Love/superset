import { generateText, type LanguageModel } from "ai";
import {
	callSmallModel,
	type SmallModelAttempt,
} from "lib/ai/call-small-model";

/**
 * AI-rewrite helper for the TODO creation form. Takes a piece of user-
 * written text (rough description or rough goal) and rewrites it into a
 * clearer, LLM-friendly instruction. Uses the existing `callSmallModel`
 * plumbing so credentials, provider fallback, and diagnostics all come
 * for free — same path as the workspace auto-namer.
 *
 * The system prompts are deliberately kept short and concrete. They do
 * NOT add length; they rewrite in place.
 */

export type TodoTextKind = "description" | "goal";

const INSTRUCTIONS: Record<TodoTextKind, string> = {
	description: [
		"あなたはユーザーが書いた雑な TODO の記述を、自律コーディングエージェントが理解しやすい明確な指示に書き換えるアシスタントです。",
		"",
		"次の観点で書き換えてください:",
		"- 何をすべきかを具体的に",
		"- 前提・対象ファイル・制約が推測できる範囲で明示",
		"- 曖昧な表現（ちゃんと/きれいに/いい感じに 等）を避ける",
		"- 元の意図は絶対に保つ。新しい要件を勝手に追加しない",
		"- 過剰な装飾・前置き・解説を付けない",
		"- 日本語で書く",
		"- 1〜6 行程度に収める",
		"- 出力は書き換え後のテキストのみ。引用符や見出しを付けない",
	].join("\n"),
	goal: [
		"あなたはユーザーが書いた雑な TODO のゴールを、自律コーディングエージェントが完了判定に使える明確な受け入れ条件に書き換えるアシスタントです。",
		"",
		"次の観点で書き換えてください:",
		"- 「〜ができている」「〜が動作している」「〜が存在する」など検証可能な形にする",
		"- 複数ある場合は箇条書き（行頭 '- '）で列挙",
		"- 曖昧な表現を避ける",
		"- 元の意図を保つ",
		"- 日本語で書く",
		"- 合計で 1〜6 行程度に収める",
		"- 出力は書き換え後のテキストのみ。引用符や見出しを付けない",
	].join("\n"),
};

export interface EnhanceTodoTextResult {
	text: string | null;
	attempts: SmallModelAttempt[];
}

export async function enhanceTodoText(
	rawText: string,
	kind: TodoTextKind,
): Promise<EnhanceTodoTextResult> {
	const cleaned = rawText.trim();
	if (!cleaned) {
		return { text: null, attempts: [] };
	}

	const system = INSTRUCTIONS[kind];

	const { result, attempts } = await callSmallModel<string>({
		invoke: async ({ model }) => {
			const { text } = await generateText({
				model: model as LanguageModel,
				system,
				prompt: cleaned,
			});
			const trimmed = text.trim();
			return trimmed.length > 0 ? trimmed : null;
		},
	});

	return { text: result ?? null, attempts };
}

/**
 * Turn a failed `callSmallModel` attempt list into a user-facing error
 * message in Japanese. Returns a generic fallback if no attempt carries
 * a useful reason.
 */
export function describeEnhanceFailure(attempts: SmallModelAttempt[]): string {
	for (let index = attempts.length - 1; index >= 0; index -= 1) {
		const attempt = attempts[index];
		if (!attempt) continue;
		if (attempt.outcome === "expired-credentials") {
			return `${attempt.issue?.message ?? `${attempt.providerName} の認証が切れています`}。設定から再接続してください。`;
		}
		if (attempt.outcome === "failed") {
			return `${attempt.providerName} での書き換えに失敗しました: ${attempt.issue?.message ?? attempt.reason ?? "unknown"}`;
		}
		if (attempt.outcome === "unsupported-credentials") {
			return `${attempt.providerName} の認証種別が書き換えに対応していません。`;
		}
	}
	if (attempts.every((a) => a.outcome === "missing-credentials")) {
		return "AI 書き換えに使えるモデルアカウントが接続されていません。設定から Anthropic か OpenAI を接続してください。";
	}
	return "AI 書き換えに失敗しました。";
}
