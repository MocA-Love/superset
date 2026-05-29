/**
 * Returns true if an assistant message contains an ask_user_question/ask_user
 * tool call that has not yet been answered.
 */
export function hasPendingQuestionToolCall(message: {
	content: unknown[];
}): boolean {
	const questionCallIds = new Set<string>();
	const resultIds = new Set<string>();

	for (const part of message.content) {
		const p = part as Record<string, unknown>;
		if (p.type === "tool_call") {
			const name = typeof p.name === "string" ? p.name : "";
			if (name === "ask_user_question" || name === "ask_user") {
				const id = typeof p.id === "string" ? p.id : "";
				if (id) questionCallIds.add(id);
			}
		}

		if (p.type === "tool_result") {
			const id = typeof p.id === "string" ? p.id : "";
			if (id) resultIds.add(id);
		}
	}

	return (
		questionCallIds.size > 0 &&
		[...questionCallIds].every((id) => !resultIds.has(id))
	);
}

/**
 * Returns true if an assistant message contains an ask_user_question/ask_user
 * tool call that already has a matching tool_result.
 */
export function hasAnsweredQuestionToolCall(message: {
	content: unknown[];
}): boolean {
	const questionCallIds = new Set<string>();
	const resultIds = new Set<string>();

	for (const part of message.content) {
		const p = part as Record<string, unknown>;
		if (p.type === "tool_call") {
			const name = typeof p.name === "string" ? p.name : "";
			if (name === "ask_user_question" || name === "ask_user") {
				const id = typeof p.id === "string" ? p.id : "";
				if (id) questionCallIds.add(id);
			}
		}

		if (p.type === "tool_result") {
			const id = typeof p.id === "string" ? p.id : "";
			if (id) resultIds.add(id);
		}
	}

	return (
		questionCallIds.size > 0 &&
		[...questionCallIds].some((id) => resultIds.has(id))
	);
}
