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
	/**
	 * Layout variant. `stacked` labels above, `row` puts model + effort
	 * side by side. Defaults to `row`.
	 */
	layout?: "stacked" | "row";
	/**
	 * Shows the "デフォルト = 〜" hint line under the row. Hidden when the
	 * caller has its own explanation nearby (e.g. the Settings tab).
	 */
	showHint?: boolean;
	/**
	 * Compact mode shrinks the control height + label size so the picker
	 * slots into tight dialog grids. Default matches the TodoModal form
	 * density.
	 */
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
	showHint = true,
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
					<Label className={labelClass}>Claude モデル</Label>
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
									<div className="flex flex-col gap-0.5 py-0.5">
										<span className="text-xs font-medium">{opt.label}</span>
										<span className="text-[10px] text-muted-foreground leading-tight">
											{opt.description}
										</span>
									</div>
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</div>
				<div className="flex flex-col gap-1.5">
					<Label className={labelClass}>思考 effort</Label>
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
									<div className="flex flex-col gap-0.5 py-0.5">
										<span className="text-xs font-medium">{opt.label}</span>
										<span className="text-[10px] text-muted-foreground leading-tight">
											{opt.description}
										</span>
									</div>
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</div>
			</div>
			{showHint && (
				<p className="text-[10px] text-muted-foreground leading-relaxed">
					デフォルト は --model / --effort を渡さないため、CLI
					側の設定（ユーザ設定や既定値）が優先される。 モデルと effort
					の組み合わせによっては Claude Code
					が対応していない場合があり、その時はセッションが即座にエラー終了する。
				</p>
			)}
		</div>
	);
}
