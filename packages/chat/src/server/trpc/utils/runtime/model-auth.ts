import { createAuthStorage } from "mastracode";
import { getOpenAICredentialsFromAuthStorage } from "../../../desktop/auth/openai/openai";

function hasAnthropicAuth(): boolean {
	const authStorage = createAuthStorage();
	authStorage.reload();
	const anthropic = authStorage.get("anthropic");
	return Boolean(
		anthropic?.type === "oauth" ||
			(anthropic?.type === "api_key" && anthropic.key.trim()),
	);
}

function hasOpenAIAuth(): boolean {
	const authStorage = createAuthStorage();
	authStorage.reload();
	return Boolean(getOpenAICredentialsFromAuthStorage(authStorage));
}

export function isModelUsableWithCurrentAuth(modelId?: string | null): boolean {
	const normalizedModelId = modelId?.trim();
	if (!normalizedModelId) return false;

	if (normalizedModelId.startsWith("anthropic/")) {
		return hasAnthropicAuth();
	}

	if (normalizedModelId.startsWith("openai/")) {
		return hasOpenAIAuth();
	}

	return true;
}
