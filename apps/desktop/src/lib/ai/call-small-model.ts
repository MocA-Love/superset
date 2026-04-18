// FORK NOTE: upstream #3517 removed fork's SmallModelProviders array
// and the provider-diagnostics store. Fork code (enhance-text.ts,
// git-operations.ts) still calls callSmallModel({ invoke }) expecting
// { result, attempts } with per-provider fallback. This shim restores
// that behavior on top of getSmallModelCandidates() (a fork-maintained
// replacement that returns the full priority list with OAuth / API key
// / proxy AUTH_TOKEN correctly wired via getAnthropicProviderOptions).
//
// Trade-offs vs. the pre-#3517 fork:
// - ProviderIssue reporting collapsed to generic `failed` — upstream
//   removed the diagnostic classifiers when it dropped
//   provider-diagnostics, and fork no longer surfaces them anywhere
//   except describeEnhanceFailure's reason string.
// - Credential resolution happens synchronously (mastracode token
//   refresh is not awaited in the candidate list). If an OAuth access
//   token is actually expired, the next candidate in the priority
//   chain is tried.
import { getSmallModelCandidates } from "@superset/chat/server/shared";
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

function toShimCredentialKind(
	kind: "apiKey" | "oauth",
): SmallModelCredentialKind {
	return kind === "oauth" ? "oauth" : "api_key";
}

export async function callSmallModel<TResult>({
	invoke,
	providerOrder,
}: {
	invoke: (
		context: SmallModelInvocationContext,
	) => Promise<TResult | null | undefined>;
	providerOrder?: ProviderId[];
}): Promise<{
	result: TResult | null;
	attempts: SmallModelAttempt[];
}> {
	const allCandidates = getSmallModelCandidates();

	const ordered = providerOrder
		? [...allCandidates].sort((a, b) => {
				const ai = providerOrder.indexOf(a.providerId);
				const bi = providerOrder.indexOf(b.providerId);
				return (
					(ai === -1 ? Number.MAX_SAFE_INTEGER : ai) -
					(bi === -1 ? Number.MAX_SAFE_INTEGER : bi)
				);
			})
		: allCandidates;

	const attempts: SmallModelAttempt[] = [];

	if (ordered.length === 0) {
		// No credentials at all for either provider. Fabricate two
		// missing-credentials attempts so describeEnhanceFailure's
		// "every attempt is missing-credentials" branch triggers the
		// correct "アカウントが接続されていません" message.
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

	for (const candidate of ordered) {
		const credentials: SmallModelCredential = {
			kind: toShimCredentialKind(candidate.credentialKind),
			source: candidate.credentialSource,
		};
		let model: unknown;
		try {
			model = candidate.createModel();
		} catch (error) {
			attempts.push({
				providerId: candidate.providerId,
				providerName: candidate.providerName,
				credentialKind: credentials.kind,
				credentialSource: candidate.credentialSource,
				outcome: "failed",
				reason: error instanceof Error ? error.message : String(error),
			});
			continue;
		}

		try {
			const result = await invoke({
				providerId: candidate.providerId,
				providerName: candidate.providerName,
				model,
				credentials,
			});
			if (result === null || result === undefined) {
				attempts.push({
					providerId: candidate.providerId,
					providerName: candidate.providerName,
					credentialKind: credentials.kind,
					credentialSource: candidate.credentialSource,
					outcome: "empty-result",
				});
				continue;
			}
			attempts.push({
				providerId: candidate.providerId,
				providerName: candidate.providerName,
				credentialKind: credentials.kind,
				credentialSource: candidate.credentialSource,
				outcome: "succeeded",
			});
			return { result, attempts };
		} catch (error) {
			attempts.push({
				providerId: candidate.providerId,
				providerName: candidate.providerName,
				credentialKind: credentials.kind,
				credentialSource: candidate.credentialSource,
				outcome: "failed",
				reason: error instanceof Error ? error.message : String(error),
			});
		}
	}

	return { result: null, attempts };
}
