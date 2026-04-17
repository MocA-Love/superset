import { Label } from "@superset/ui/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@superset/ui/select";
import { cn } from "@superset/ui/utils";
import {
	CLAUDE_EFFORT_SELECT_OPTIONS,
	CLAUDE_MODEL_SELECT_OPTIONS,
	type ClaudeEffortPick,
	type ClaudeModelPick,
} from "./claudeRuntimeOptions";

interface ClaudeRuntimePickerProps {
	model: ClaudeModelPick;
	effort: ClaudeEffortPick;
	onModelChange: (value: ClaudeModelPick) => void;
	onEffortChange: (value: ClaudeEffortPick) => void;
	disabled?: boolean;
	layout?: "stacked" | "row";
	compact?: boolean;
}

/**
 * Model + effort picker used by the TODO composer, the Schedule editor,
 * and the global defaults tab of the preset dialog. The Select surface
 * is shared so picking a new model / effort for a single TODO or for the
 * global default uses the exact same controls (including localized
 * labels and the "Claude Code の既定値" sentinel).
 */
export function ClaudeRuntimePicker({
	model,
	effort,
	onModelChange,
	onEffortChange,
	disabled,
	layout = "row",
	compact = true,
}: ClaudeRuntimePickerProps) {
	const labelClass = compact ? "text-xs" : "text-sm";
	const triggerClass = compact ? "h-8 text-xs" : "";

	return (
		<div className={cn("flex flex-col gap-1.5")}>
			<div
				className={cn(
					"gap-3",
					layout === "row" ? "grid grid-cols-2" : "flex flex-col",
				)}
			>
				<div className="flex flex-col gap-1.5">
					<Label className={labelClass}>Model</Label>
					<Select
						value={model}
						onValueChange={(v) => onModelChange(v as ClaudeModelPick)}
						disabled={disabled}
					>
						<SelectTrigger className={triggerClass}>
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							{CLAUDE_MODEL_SELECT_OPTIONS.map((opt) => (
								<SelectItem key={opt.value} value={opt.value}>
									<span className="text-xs font-medium">{opt.label}</span>
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</div>
				<div className="flex flex-col gap-1.5">
					<Label className={labelClass}>Effort</Label>
					<Select
						value={effort}
						onValueChange={(v) => onEffortChange(v as ClaudeEffortPick)}
						disabled={disabled}
					>
						<SelectTrigger className={triggerClass}>
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							{CLAUDE_EFFORT_SELECT_OPTIONS.map((opt) => (
								<SelectItem key={opt.value} value={opt.value}>
									<span className="text-xs font-medium">{opt.label}</span>
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</div>
			</div>
		</div>
	);
}
