import {
	Conversation,
	ConversationContent,
	ConversationEmptyState,
	ConversationLoadingState,
	ConversationScrollButton,
} from "@superset/ui/ai-elements/conversation";
import { useMemo, useRef } from "react";
import { HiMiniChatBubbleLeftRight } from "react-icons/hi2";
import type {
	ChatMessage,
	ChatMessageListProps,
} from "./ChatMessageList.types";
import { AssistantMessage } from "./components/AssistantMessage";
import { ChatSearch } from "./components/ChatSearch";
import { InterruptedFooter } from "./components/InterruptedFooter";
import { MessageScrollbackRail } from "./components/MessageScrollbackRail";
import { PendingApprovalMessage } from "./components/PendingApprovalMessage";
import { PendingPlanApprovalMessage } from "./components/PendingPlanApprovalMessage";
import { PendingQuestionMessage } from "./components/PendingQuestionMessage";
import { SubagentExecutionMessage } from "./components/SubagentExecutionMessage";
import { ThinkingMessage } from "./components/ThinkingMessage";
import { ToolPreviewMessage } from "./components/ToolPreviewMessage";
import { UserMessage } from "./components/UserMessage";
import { useChatMessageSearch } from "./hooks/useChatMessageSearch";
import {
	findLatestSubmitPlanToolCallId,
	getInterruptedPreview,
	getStreamingPreviewToolParts,
	getVisibleMessages,
	removeInterruptedSourceMessage,
	resolvePendingPlanToolCallId,
} from "./utils/messageListHelpers";

function isCompactAssistantMessage(message: ChatMessage): boolean {
	if (message.role !== "assistant" || message.content.length === 0) {
		return false;
	}

	return message.content.every(
		(part) =>
			part.type === "tool_call" ||
			part.type === "tool_result" ||
			part.type.startsWith("om_"),
	);
}

export function ChatMessageList({
	messages,
	isFocused,
	isRunning,
	isConversationLoading,
	isAwaitingAssistant,
	currentMessage,
	interruptedMessage,
	workspaceId,
	sessionId,
	organizationId,
	workspaceCwd,
	activeTools,
	toolInputBuffers,
	activeSubagents,
	pendingApproval,
	isApprovalSubmitting,
	onApprovalRespond,
	pendingPlanApproval,
	isPlanSubmitting,
	onPlanRespond,
	pendingQuestion,
	isQuestionSubmitting,
	onQuestionRespond,
	editingUserMessageId,
	isEditSubmitting,
	onStartEditUserMessage,
	onCancelEditUserMessage,
	onSubmitEditedUserMessage,
	onRestartUserMessage,
}: ChatMessageListProps) {
	const messageListRef = useRef<HTMLDivElement>(null);
	const chatSearch = useChatMessageSearch({
		containerRef: messageListRef,
		isFocused,
	});

	const visibleMessages = useMemo(
		() =>
			getVisibleMessages({
				messages,
				isRunning,
				currentMessage,
			}),
		[currentMessage, isRunning, messages],
	);

	const interruptedPreview = useMemo(
		() =>
			getInterruptedPreview({
				isRunning,
				interruptedMessage,
			}),
		[interruptedMessage, isRunning],
	);

	const renderedMessages = useMemo(
		() =>
			removeInterruptedSourceMessage({
				messages: visibleMessages,
				interruptedMessage: interruptedPreview ? interruptedMessage : null,
			}),
		[interruptedMessage, interruptedPreview, visibleMessages],
	);
	const messageRenderGroups = useMemo(() => {
		const groups: Array<
			| {
					kind: "single";
					message: ChatMessage;
					originalIndex: number;
			  }
			| {
					kind: "compact-assistant-group";
					messages: ChatMessage[];
					startIndex: number;
			  }
		> = [];

		for (let index = 0; index < renderedMessages.length; index++) {
			const message = renderedMessages[index];
			if (!isCompactAssistantMessage(message)) {
				groups.push({
					kind: "single",
					message,
					originalIndex: index,
				});
				continue;
			}

			const compactGroup = [message];
			let nextIndex = index + 1;
			while (
				nextIndex < renderedMessages.length &&
				isCompactAssistantMessage(renderedMessages[nextIndex] as ChatMessage)
			) {
				compactGroup.push(renderedMessages[nextIndex] as ChatMessage);
				nextIndex++;
			}

			if (compactGroup.length === 1) {
				groups.push({
					kind: "single",
					message,
					originalIndex: index,
				});
				continue;
			}

			groups.push({
				kind: "compact-assistant-group",
				messages: compactGroup,
				startIndex: index,
			});
			index = nextIndex - 1;
		}

		return groups;
	}, [renderedMessages]);

	const previewToolParts = useMemo(
		() =>
			getStreamingPreviewToolParts({
				activeTools,
				toolInputBuffers,
			}),
		[activeTools, toolInputBuffers],
	);
	const activeSubagentEntries = useMemo(
		() => (activeSubagents ? [...activeSubagents.entries()] : []),
		[activeSubagents],
	);
	const anchoredSubagentToolCallIds = useMemo(() => {
		const toolCallIds = new Set<string>();
		const collectFromMessage = (message: ChatMessage | null) => {
			if (!message) return;
			for (const part of message.content) {
				if (
					(part.type === "tool_call" || part.type === "tool_result") &&
					typeof part.id === "string" &&
					part.id.length > 0
				) {
					toolCallIds.add(part.id);
				}
			}
		};

		for (const message of renderedMessages) {
			collectFromMessage(message);
		}
		collectFromMessage(interruptedPreview);
		if (currentMessage?.role === "assistant") {
			collectFromMessage(currentMessage);
		}
		for (const previewPart of previewToolParts) {
			toolCallIds.add(previewPart.toolCallId);
		}
		return toolCallIds;
	}, [currentMessage, interruptedPreview, previewToolParts, renderedMessages]);
	const inlineSubagentEntries = useMemo(
		() =>
			activeSubagentEntries.filter(([toolCallId]) =>
				anchoredSubagentToolCallIds.has(toolCallId),
			),
		[activeSubagentEntries, anchoredSubagentToolCallIds],
	);
	const orphanedSubagentEntries = useMemo(
		() =>
			activeSubagentEntries.filter(
				([toolCallId]) => !anchoredSubagentToolCallIds.has(toolCallId),
			),
		[activeSubagentEntries, anchoredSubagentToolCallIds],
	);
	const hasSubagentActivity = activeSubagentEntries.length > 0;

	const pendingPlanToolCallId = useMemo(() => {
		const anchorMessages: ChatMessage[] = [...renderedMessages];
		if (interruptedPreview) {
			anchorMessages.push(interruptedPreview);
		}
		if (currentMessage?.role === "assistant") {
			anchorMessages.push(currentMessage);
		}

		const latestSubmitPlanToolCallId = findLatestSubmitPlanToolCallId({
			messages: anchorMessages,
			previewToolParts,
		});

		return resolvePendingPlanToolCallId({
			pendingPlanApproval,
			fallbackToolCallId: latestSubmitPlanToolCallId,
		});
	}, [
		currentMessage,
		interruptedPreview,
		pendingPlanApproval,
		previewToolParts,
		renderedMessages,
	]);

	const shouldShowStandalonePendingPlan = Boolean(
		pendingPlanApproval && !pendingPlanToolCallId,
	);

	const canShowPendingAssistantUi =
		isAwaitingAssistant &&
		!currentMessage &&
		!hasSubagentActivity &&
		!pendingApproval &&
		!pendingQuestion;
	const shouldShowThinking =
		canShowPendingAssistantUi &&
		!pendingPlanApproval &&
		previewToolParts.length === 0;
	const shouldShowToolPreview =
		canShowPendingAssistantUi &&
		previewToolParts.length > 0 &&
		(!pendingPlanApproval || Boolean(pendingPlanToolCallId));

	const hasConversationContent =
		renderedMessages.length > 0 || Boolean(interruptedPreview);
	const shouldShowConversationLoading =
		isConversationLoading && !isAwaitingAssistant && !hasConversationContent;
	const shouldShowEmptyState =
		!shouldShowConversationLoading && !hasConversationContent;

	const inlineToolStateProps = {
		pendingPlanApproval,
		pendingPlanToolCallId,
		isPlanSubmitting,
		onPlanRespond,
	} as const;
	const renderAssistantMessage = (message: ChatMessage) => (
		<AssistantMessage
			key={message.id}
			message={message}
			workspaceId={workspaceId}
			sessionId={sessionId}
			organizationId={organizationId}
			workspaceCwd={workspaceCwd}
			isStreaming={false}
			previewToolParts={[]}
			subagentEntries={inlineSubagentEntries}
			{...inlineToolStateProps}
		/>
	);

	return (
		<Conversation className="flex-1">
			<ConversationContent className="mx-auto w-full max-w-[680px] py-6">
				<div ref={messageListRef} className="flex flex-col gap-6">
					{shouldShowConversationLoading ? (
						<ConversationLoadingState />
					) : shouldShowEmptyState ? (
						<ConversationEmptyState
							title="Start a conversation"
							description="Ask anything to get started"
							icon={<HiMiniChatBubbleLeftRight className="size-8" />}
						/>
					) : (
						messageRenderGroups.map((group) => {
							if (group.kind === "compact-assistant-group") {
								return (
									<div
										key={`compact-group-${group.startIndex}`}
										data-compact-assistant-group={group.messages.length}
										className="flex flex-col gap-2"
									>
										{group.messages.map((message) =>
											renderAssistantMessage(message),
										)}
									</div>
								);
							}

							const { message, originalIndex } = group;
							if (message.role === "user") {
								return (
									<UserMessage
										key={message.id}
										message={message}
										prefixMessages={renderedMessages.slice(0, originalIndex)}
										workspaceId={workspaceId}
										workspaceCwd={workspaceCwd}
										isEditing={editingUserMessageId === message.id}
										isSubmitting={isEditSubmitting}
										onStartEdit={onStartEditUserMessage}
										onCancelEdit={onCancelEditUserMessage}
										onSubmitEdit={onSubmitEditedUserMessage}
										onRestart={onRestartUserMessage}
										actionDisabled={isAwaitingAssistant}
									/>
								);
							}

							return renderAssistantMessage(message);
						})
					)}
					{interruptedPreview && (
						<AssistantMessage
							key={interruptedPreview.id}
							message={interruptedPreview}
							workspaceId={workspaceId}
							sessionId={sessionId}
							organizationId={organizationId}
							workspaceCwd={workspaceCwd}
							isStreaming={false}
							previewToolParts={[]}
							subagentEntries={inlineSubagentEntries}
							{...inlineToolStateProps}
							footer={<InterruptedFooter />}
						/>
					)}
					{isRunning && currentMessage && (
						<AssistantMessage
							key={`current-${currentMessage.id}`}
							message={currentMessage}
							workspaceId={workspaceId}
							sessionId={sessionId}
							organizationId={organizationId}
							workspaceCwd={workspaceCwd}
							isStreaming
							previewToolParts={previewToolParts}
							subagentEntries={inlineSubagentEntries}
							{...inlineToolStateProps}
						/>
					)}
					{shouldShowThinking ? <ThinkingMessage /> : null}
					{shouldShowToolPreview ? (
						<ToolPreviewMessage
							previewToolParts={previewToolParts}
							workspaceId={workspaceId}
							sessionId={sessionId}
							organizationId={organizationId}
							workspaceCwd={workspaceCwd}
							pendingPlanApproval={pendingPlanApproval}
							pendingPlanToolCallId={pendingPlanToolCallId}
							isPlanSubmitting={isPlanSubmitting}
							onPlanRespond={onPlanRespond}
						/>
					) : null}
					{orphanedSubagentEntries.length > 0 ? (
						<SubagentExecutionMessage subagents={orphanedSubagentEntries} />
					) : null}
					{pendingApproval && (
						<PendingApprovalMessage
							approval={pendingApproval}
							isSubmitting={isApprovalSubmitting}
							onRespond={onApprovalRespond}
						/>
					)}
					{shouldShowStandalonePendingPlan && pendingPlanApproval && (
						<PendingPlanApprovalMessage
							planApproval={pendingPlanApproval}
							isSubmitting={isPlanSubmitting}
							onRespond={onPlanRespond}
						/>
					)}
					{pendingQuestion && (
						<PendingQuestionMessage
							question={pendingQuestion}
							isSubmitting={isQuestionSubmitting}
							onRespond={onQuestionRespond}
						/>
					)}
				</div>
			</ConversationContent>
			<ChatSearch
				isOpen={chatSearch.isSearchOpen}
				query={chatSearch.query}
				caseSensitive={chatSearch.caseSensitive}
				matchCount={chatSearch.matchCount}
				activeMatchIndex={chatSearch.activeMatchIndex}
				onQueryChange={chatSearch.setQuery}
				onCaseSensitiveChange={chatSearch.setCaseSensitive}
				onFindNext={chatSearch.findNext}
				onFindPrevious={chatSearch.findPrevious}
				onClose={chatSearch.closeSearch}
			/>
			<MessageScrollbackRail messages={renderedMessages} />
			<ConversationScrollButton />
		</Conversation>
	);
}
