import type { ThinkingLevel } from "@superset/ui/ai-elements/thinking-toggle";

const FORCED_LOW_THINKING_MODEL_PREFIXES = ["openai/gpt-5"] as const;

export function requiresMinimumThinkingLevel(modelId?: string | null): boolean {
	if (!modelId) return false;
	return FORCED_LOW_THINKING_MODEL_PREFIXES.some((prefix) =>
		modelId.startsWith(prefix),
	);
}

export function getEffectiveThinkingLevel(
	thinkingLevel: ThinkingLevel,
	modelId?: string | null,
): ThinkingLevel {
	if (thinkingLevel === "off" && requiresMinimumThinkingLevel(modelId)) {
		return "low";
	}
	return thinkingLevel;
}

export function getThinkingIndicatorLabel(
	thinkingLevel: ThinkingLevel,
): string {
	return thinkingLevel === "off" ? "Working..." : "Thinking...";
}

export function getForcedThinkingDisabledLevels(
	modelId?: string | null,
): Partial<Record<ThinkingLevel, string>> {
	if (!requiresMinimumThinkingLevel(modelId)) {
		return {};
	}

	return {
		off: "GPT-5 models require at least Low reasoning",
	};
}

export function getForcedThinkingHint(
	modelId?: string | null,
): string | undefined {
	if (!requiresMinimumThinkingLevel(modelId)) {
		return undefined;
	}

	return "GPT-5 models require at least Low reasoning.";
}
