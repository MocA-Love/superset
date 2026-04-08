import { Message, MessageContent } from "@superset/ui/ai-elements/message";
import { ShimmerLabel } from "@superset/ui/ai-elements/shimmer-label";

interface ThinkingMessageProps {
	label?: string;
}

export function ThinkingMessage({
	label = "Thinking...",
}: ThinkingMessageProps) {
	return (
		<Message from="assistant">
			<MessageContent>
				<ShimmerLabel className="text-sm text-muted-foreground">
					{label}
				</ShimmerLabel>
			</MessageContent>
		</Message>
	);
}
