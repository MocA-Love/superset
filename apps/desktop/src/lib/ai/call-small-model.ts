// FORK NOTE: upstream #3580 (#3580) replaced getSmallModelCandidates() with
// an async getSmallModel() that resolves a single model. This shim keeps the
// callSmallModel({ invoke }) interface that fork code (enhance-text.ts,
// git-operations.ts) expects, but now delegates to getSmallModel() instead of
// iterating a candidate list. Provider fallback and attempt tracking are
// simplified — getSmallModel() already handles the priority chain internally.
import { getSmallModel } from "@superset/chat/server/shared";
import type { ProviderId, ProviderIssue } from "shared/ai/provider-status";

export type SmallModelCredentialKind = "api_key" | "oauth" | "env";
export interface SmallModelCredential {
	kind: SmallModelCredentialKind;
	source?: string;
}

export interface SmallModelAttempt {
	providerId: ProviderId;
	providerName: string;
	credentialKind?: SmallModelCredentialKind;
	credentialSource?: string;
	issue?: ProviderIssue;
	outcome:
		| "missing-credentials"
		| "expired-credentials"
		| "unsupported-credentials"
		| "empty-result"
		| "failed"
		| "succeeded";
	reason?: string;
}

export interface SmallModelInvocationContext {
	providerId: ProviderId;
	providerName: string;
	model: unknown;
	credentials: SmallModelCredential;
}

export async function callSmallModel<TResult>({
	invoke,
}: {
	invoke: (
		context: SmallModelInvocationContext,
	) => Promise<TResult | null | undefined>;
	providerOrder?: ProviderId[];
}): Promise<{
	result: TResult | null;
	attempts: SmallModelAttempt[];
}> {
	const model = await getSmallModel();

	if (!model) {
		return {
			result: null,
			attempts: [
				{
					providerId: "anthropic",
					providerName: "Anthropic",
					outcome: "missing-credentials",
				},
				{
					providerId: "openai",
					providerName: "OpenAI",
					outcome: "missing-credentials",
				},
			],
		};
	}

	try {
		const result = await invoke({
			providerId: "anthropic",
			providerName: "Anthropic",
			model,
			credentials: { kind: "api_key" },
		});
		if (result === null || result === undefined) {
			return {
				result: null,
				attempts: [
					{
						providerId: "anthropic",
						providerName: "Anthropic",
						outcome: "empty-result",
					},
				],
			};
		}
		return {
			result,
			attempts: [
				{
					providerId: "anthropic",
					providerName: "Anthropic",
					outcome: "succeeded",
				},
			],
		};
	} catch (error) {
		return {
			result: null,
			attempts: [
				{
					providerId: "anthropic",
					providerName: "Anthropic",
					outcome: "failed",
					reason: error instanceof Error ? error.message : String(error),
				},
			],
		};
	}
}
