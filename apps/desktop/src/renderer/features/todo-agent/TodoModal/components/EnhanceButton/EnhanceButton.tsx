import { Button } from "@superset/ui/button";
import { toast } from "@superset/ui/sonner";
import { cn } from "@superset/ui/utils";
import { useCallback, useState } from "react";
import { HiMiniSparkles } from "react-icons/hi2";
import { electronTrpc } from "renderer/lib/electron-trpc";

interface EnhanceButtonProps {
	value: string;
	onEnhanced: (next: string) => void;
	kind: "description" | "goal";
	title?: string;
}

/**
 * Tiny sparkle/✨ button that sits in the top-right of a TODO textarea.
 * Click → send the field's current text to a small model, replace the
 * field value with the rewritten version. Mirrors the common "Improve
 * writing" / "Enhance prompt" affordance seen in Raycast, Linear AI,
 * Notion AI, and v0. Backend uses `callSmallModel` (Haiku-class).
 */
export function EnhanceButton({
	value,
	onEnhanced,
	kind,
	title,
}: EnhanceButtonProps) {
	const [running, setRunning] = useState(false);
	const enhance = electronTrpc.todoAgent.enhanceText.useMutation();

	const disabled = running || value.trim().length === 0;

	const handleClick = useCallback(async () => {
		if (disabled) return;
		setRunning(true);
		try {
			const { text } = await enhance.mutateAsync({
				text: value,
				kind,
			});
			if (text) {
				onEnhanced(text);
				toast.success("AI 書き換え完了");
			}
		} catch (error) {
			toast.error(
				error instanceof Error ? error.message : "AI 書き換えに失敗しました",
			);
		} finally {
			setRunning(false);
		}
	}, [disabled, enhance, kind, onEnhanced, value]);

	return (
		<Button
			type="button"
			size="sm"
			variant="ghost"
			className="h-6 gap-1 px-1.5 text-[10px] text-muted-foreground hover:text-primary"
			onClick={handleClick}
			disabled={disabled}
			title={title ?? "AI で書き換える"}
		>
			<HiMiniSparkles
				className={cn("size-3.5", running && "animate-pulse")}
			/>
			<span>{running ? "書き換え中…" : "AI"}</span>
		</Button>
	);
}
