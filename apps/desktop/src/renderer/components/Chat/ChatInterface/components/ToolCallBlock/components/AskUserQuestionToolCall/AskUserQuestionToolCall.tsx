import { MessageResponse } from "@superset/ui/ai-elements/message";
import { UserQuestionTool } from "@superset/ui/ai-elements/user-question-tool";
import { MessageCircleQuestionIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { ToolPart } from "../../../../utils/tool-helpers";
import { SupersetToolCall } from "../SupersetToolCall";

interface QuestionToolOption {
	label: string;
	description?: string;
}

interface QuestionToolQuestion {
	question: string;
	header?: string;
	options: QuestionToolOption[];
	multiSelect?: boolean;
}

interface AskUserQuestionToolCallProps {
	part: ToolPart;
	args: Record<string, unknown>;
	result: Record<string, unknown>;
	outputObject?: Record<string, unknown>;
	nestedResultObject?: Record<string, unknown>;
	isStreaming?: boolean;
	isInterrupted?: boolean;
	onAnswer?: (
		toolCallId: string,
		answers: Record<string, string>,
	) => Promise<void> | void;
}

function toRecord(value: unknown): Record<string, unknown> | undefined {
	if (typeof value === "object" && value !== null && !Array.isArray(value)) {
		return value as Record<string, unknown>;
	}
	return undefined;
}

function toQuestionToolQuestions(value: unknown): QuestionToolQuestion[] {
	if (!Array.isArray(value)) return [];

	return value
		.map((item): QuestionToolQuestion | null => {
			if (typeof item !== "object" || item === null) return null;
			const record = item as Record<string, unknown>;
			const question =
				typeof record.question === "string" ? record.question.trim() : "";
			if (!question) return null;

			const options = Array.isArray(record.options)
				? record.options
						.map((option): QuestionToolOption | null => {
							if (typeof option !== "object" || option === null) return null;
							const optionRecord = option as Record<string, unknown>;
							const label =
								typeof optionRecord.label === "string"
									? optionRecord.label.trim()
									: "";
							if (!label) return null;
							const description =
								typeof optionRecord.description === "string"
									? optionRecord.description.trim()
									: "";

							return description ? { label, description } : { label };
						})
						.filter((option): option is QuestionToolOption => option !== null)
				: [];

			const header =
				typeof record.header === "string" ? record.header.trim() : "";
			const multiSelect =
				typeof record.multiSelect === "boolean"
					? record.multiSelect
					: undefined;

			return {
				question,
				...(header ? { header } : {}),
				options,
				...(multiSelect === undefined ? {} : { multiSelect }),
			};
		})
		.filter((question): question is QuestionToolQuestion => question !== null);
}

function toQuestionToolAnswers(value: unknown): Record<string, string> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return {};
	}

	const answers: Record<string, string> = {};
	for (const [key, answer] of Object.entries(value)) {
		if (typeof answer !== "string") continue;
		const trimmedKey = key.trim();
		const trimmedAnswer = answer.trim();
		if (!trimmedKey || !trimmedAnswer) continue;
		answers[trimmedKey] = trimmedAnswer;
	}

	return answers;
}

function findAnswerForQuestion({
	answers,
	questionText,
}: {
	answers: Record<string, string>;
	questionText: string;
}): string | undefined {
	const directAnswer = answers[questionText];
	if (directAnswer) return directAnswer;

	const trimmedQuestion = questionText.trim();
	for (const [answerKey, answerValue] of Object.entries(answers)) {
		if (answerKey.trim() === trimmedQuestion) return answerValue;
	}

	return undefined;
}

function toSingleQuestion(
	args: Record<string, unknown>,
): QuestionToolQuestion[] {
	const question =
		typeof args.question === "string" ? args.question.trim() : "";
	if (!question) return [];

	const options = Array.isArray(args.options)
		? args.options
				.map((option): QuestionToolOption | null => {
					if (typeof option !== "object" || option === null) return null;
					const optionRecord = option as Record<string, unknown>;
					const label =
						typeof optionRecord.label === "string"
							? optionRecord.label.trim()
							: "";
					if (!label) return null;
					const description =
						typeof optionRecord.description === "string"
							? optionRecord.description.trim()
							: "";
					return description ? { label, description } : { label };
				})
				.filter((option): option is QuestionToolOption => option !== null)
		: [];

	return [{ question, options }];
}

// FORK NOTE: fork uses buildQuestionMarkdown + UserQuestionTool instead of the
// upstream ToolCallRow/ToolStatusBadge pattern; fork implementation maintained here.
function buildQuestionMarkdown({
	questions,
	answers,
	status,
}: {
	questions: QuestionToolQuestion[];
	answers: Record<string, string>;
	status?: string;
}): string {
	if (questions.length === 0) return "";

	const lines: string[] = ["### Agent question"];
	for (const [index, question] of questions.entries()) {
		lines.push("");
		if (questions.length > 1) {
			lines.push(`#### ${index + 1}`);
		}
		if (question.header) {
			lines.push(`_${question.header}_`);
		}
		lines.push(question.question);

		const answer = findAnswerForQuestion({
			answers,
			questionText: question.question,
		});
		if (answer) {
			lines.push("");
			lines.push(`**Answer:** ${answer}`);
		} else if (status) {
			lines.push("");
			lines.push(`**Status:** ${status}`);
		}
	}

	return lines.join("\n").trim();
}

export function AskUserQuestionToolCall({
	part,
	args,
	result,
	outputObject,
	nestedResultObject,
	isInterrupted,
	onAnswer,
}: AskUserQuestionToolCallProps) {
	const [optimisticAnswers, setOptimisticAnswers] = useState<Record<
		string,
		string
	> | null>(null);
	const [isSubmittingLocally, setIsSubmittingLocally] = useState(false);

	useEffect(() => {
		if (part.state === "output-available" || part.state === "output-error") {
			setIsSubmittingLocally(false);
		}
	}, [part.state]);

	const questions = useMemo(() => {
		return Array.isArray(args.questions)
			? toQuestionToolQuestions(args.questions)
			: toSingleQuestion(args);
	}, [args]);

	const serverAnswers = useMemo(() => {
		return toQuestionToolAnswers(
			toRecord(result.answers) ??
				toRecord(outputObject?.answers) ??
				toRecord(nestedResultObject?.answers),
		);
	}, [nestedResultObject?.answers, outputObject?.answers, result.answers]);

	const isResultError = result.isError === true;
	const answerFallbackText = useMemo(() => {
		if (isResultError) return undefined;
		if (typeof result.text === "string" && result.text.trim()) {
			return result.text.trim();
		}
		if (typeof result.answer === "string" && result.answer.trim()) {
			return result.answer.trim();
		}
		if (typeof result.content === "string" && result.content.trim()) {
			const raw = result.content.trim();
			const prefix = "User answered: ";
			return raw.startsWith(prefix) ? raw.slice(prefix.length).trim() : raw;
		}
		return undefined;
	}, [isResultError, result.answer, result.content, result.text]);

	const displayServerAnswers = useMemo(() => {
		if (!answerFallbackText || !questions[0]) return serverAnswers;
		if (
			findAnswerForQuestion({
				answers: serverAnswers,
				questionText: questions[0].question,
			})
		) {
			return serverAnswers;
		}
		return {
			...serverAnswers,
			[questions[0].question]: answerFallbackText,
		};
	}, [answerFallbackText, questions, serverAnswers]);

	const answers = optimisticAnswers ?? displayServerAnswers;
	const hasOutput =
		part.state === "output-available" || part.state === "output-error";
	const isCancelledByStop = Boolean(isInterrupted) && !hasOutput;
	const isCancelledByError = part.state === "output-error" || isResultError;
	const cancellationStatus =
		isCancelledByStop || isCancelledByError ? "Aborted by the user" : undefined;
	const markdown = buildQuestionMarkdown({
		questions,
		answers,
		status: cancellationStatus,
	});
	const hasQuestions = questions.length > 0;
	const canRespond =
		Boolean(onAnswer) &&
		!hasOutput &&
		!isCancelledByStop &&
		!isSubmittingLocally;

	const messageBlock = markdown ? (
		<div className="rounded-lg border border-border/60 bg-muted/20 p-3">
			<MessageResponse
				animated={false}
				isAnimating={false}
				mermaid={{
					config: {
						theme: "default",
					},
				}}
			>
				{markdown}
			</MessageResponse>
		</div>
	) : null;

	const handleSubmit = (submittedAnswers: Record<string, string>): void => {
		if (!onAnswer || isSubmittingLocally) return;
		setOptimisticAnswers(submittedAnswers);
		setIsSubmittingLocally(true);

		void Promise.resolve(onAnswer(part.toolCallId, submittedAnswers)).catch(
			() => {
				setOptimisticAnswers(null);
				setIsSubmittingLocally(false);
			},
		);
	};

	if (!hasQuestions) {
		return (
			<SupersetToolCall
				part={part}
				toolName="Question"
				icon={MessageCircleQuestionIcon}
			/>
		);
	}

	if (hasOutput || isCancelledByStop || !onAnswer || optimisticAnswers) {
		return (
			<div className="space-y-2">
				{messageBlock}
				<SupersetToolCall
					part={part}
					toolName="Question"
					icon={MessageCircleQuestionIcon}
				/>
			</div>
		);
	}

	if (!canRespond) {
		return (
			<div className="space-y-2">
				{messageBlock}
				<SupersetToolCall
					part={part}
					toolName="Question"
					icon={MessageCircleQuestionIcon}
				/>
			</div>
		);
	}

	return (
		<div className="space-y-2">
			{messageBlock}
			<UserQuestionTool
				questions={questions}
				onAnswer={handleSubmit}
				onSkip={() => handleSubmit({})}
			/>
		</div>
	);
}
