import { Label } from "@superset/ui/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@superset/ui/select";
import { cn } from "@superset/ui/utils";
import type { AgentKind } from "main/todo-agent/types";
import {
	CLAUDE_EFFORT_SELECT_OPTIONS,
	CLAUDE_MODEL_SELECT_OPTIONS,
	type ClaudeEffortPick,
	type ClaudeModelPick,
	CODEX_EFFORT_SELECT_OPTIONS,
	CODEX_MODEL_SELECT_OPTIONS,
	type CodexEffortPick,
	type CodexModelPick,
	type CrushModelPick,
	DEFAULT_SENTINEL,
} from "./claudeRuntimeOptions";

interface AgentRuntimePickerProps {
	agentKind: AgentKind;
	onAgentKindChange: (value: AgentKind) => void;
	claudeModel: ClaudeModelPick;
	claudeEffort: ClaudeEffortPick;
	onClaudeModelChange: (value: ClaudeModelPick) => void;
	onClaudeEffortChange: (value: ClaudeEffortPick) => void;
	codexModel: CodexModelPick;
	codexEffort: CodexEffortPick;
	onCodexModelChange: (value: CodexModelPick) => void;
	onCodexEffortChange: (value: CodexEffortPick) => void;
	crushModel: CrushModelPick;
	onCrushModelChange: (value: CrushModelPick) => void;
	crushModels: string[];
	disabled?: boolean;
	layout?: "stacked" | "row";
	compact?: boolean;
}

const AGENT_KIND_OPTIONS: Array<{
	value: AgentKind;
	label: string;
	description: string;
}> = [
	{
		value: "claude",
		label: "Claude Code",
		description: "Anthropic Claude Code CLI",
	},
	{
		value: "codex",
		label: "Codex CLI",
		description: "OpenAI Codex CLI (codex exec)",
	},
	{
		value: "crush",
		label: "Crush",
		description: "Charmbracelet Crush CLI (crush run)",
	},
];

export function AgentRuntimePicker({
	agentKind,
	onAgentKindChange,
	claudeModel,
	claudeEffort,
	onClaudeModelChange,
	onClaudeEffortChange,
	codexModel,
	codexEffort,
	onCodexModelChange,
	onCodexEffortChange,
	crushModel,
	onCrushModelChange,
	crushModels,
	disabled,
	layout = "row",
	compact = true,
}: AgentRuntimePickerProps) {
	const labelClass = compact ? "text-xs" : "text-sm";
	const triggerClass = compact ? "h-8 text-xs" : "";

	return (
		<div className={cn("flex flex-col gap-1.5")}>
			<div className="flex flex-col gap-1.5">
				<Label className={labelClass}>Agent</Label>
				<Select
					value={agentKind}
					onValueChange={(v) => onAgentKindChange(v as AgentKind)}
					disabled={disabled}
				>
					<SelectTrigger className={triggerClass}>
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						{AGENT_KIND_OPTIONS.map((opt) => (
							<SelectItem key={opt.value} value={opt.value}>
								<span className="text-xs font-medium">{opt.label}</span>
							</SelectItem>
						))}
					</SelectContent>
				</Select>
			</div>

			{agentKind === "crush" ? (
				<CrushModelSection
					crushModel={crushModel}
					onCrushModelChange={onCrushModelChange}
					crushModels={crushModels}
					disabled={disabled}
					labelClass={labelClass}
					triggerClass={triggerClass}
				/>
			) : (
				<ClaudeCodexModelSection
					agentKind={agentKind}
					claudeModel={claudeModel}
					claudeEffort={claudeEffort}
					onClaudeModelChange={onClaudeModelChange}
					onClaudeEffortChange={onClaudeEffortChange}
					codexModel={codexModel}
					codexEffort={codexEffort}
					onCodexModelChange={onCodexModelChange}
					onCodexEffortChange={onCodexEffortChange}
					disabled={disabled}
					layout={layout}
					labelClass={labelClass}
					triggerClass={triggerClass}
				/>
			)}
		</div>
	);
}

function ClaudeCodexModelSection({
	agentKind,
	claudeModel,
	claudeEffort,
	onClaudeModelChange,
	onClaudeEffortChange,
	codexModel,
	codexEffort,
	onCodexModelChange,
	onCodexEffortChange,
	disabled,
	layout,
	labelClass,
	triggerClass,
}: {
	agentKind: "claude" | "codex";
	claudeModel: ClaudeModelPick;
	claudeEffort: ClaudeEffortPick;
	onClaudeModelChange: (v: ClaudeModelPick) => void;
	onClaudeEffortChange: (v: ClaudeEffortPick) => void;
	codexModel: CodexModelPick;
	codexEffort: CodexEffortPick;
	onCodexModelChange: (v: CodexModelPick) => void;
	onCodexEffortChange: (v: CodexEffortPick) => void;
	disabled?: boolean;
	layout?: "stacked" | "row";
	labelClass: string;
	triggerClass: string;
}) {
	const isClaude = agentKind === "claude";
	const modelOptions = isClaude
		? CLAUDE_MODEL_SELECT_OPTIONS
		: CODEX_MODEL_SELECT_OPTIONS;
	const effortOptions = isClaude
		? CLAUDE_EFFORT_SELECT_OPTIONS
		: CODEX_EFFORT_SELECT_OPTIONS;
	const currentModel = isClaude ? claudeModel : codexModel;
	const currentEffort = isClaude ? claudeEffort : codexEffort;
	const onModelChange = isClaude ? onClaudeModelChange : onCodexModelChange;
	const onEffortChange = isClaude ? onClaudeEffortChange : onCodexEffortChange;

	return (
		<div
			className={cn(
				"gap-3",
				layout === "row" ? "grid grid-cols-2" : "flex flex-col",
			)}
		>
			<div className="flex flex-col gap-1.5">
				<Label className={labelClass}>Model</Label>
				<Select
					value={currentModel}
					onValueChange={(v) =>
						onModelChange(v as ClaudeModelPick & CodexModelPick)
					}
					disabled={disabled}
				>
					<SelectTrigger className={triggerClass}>
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						{modelOptions.map((opt) => (
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
					value={currentEffort}
					onValueChange={(v) =>
						onEffortChange(v as ClaudeEffortPick & CodexEffortPick)
					}
					disabled={disabled}
				>
					<SelectTrigger className={triggerClass}>
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						{effortOptions.map((opt) => (
							<SelectItem key={opt.value} value={opt.value}>
								<span className="text-xs font-medium">{opt.label}</span>
							</SelectItem>
						))}
					</SelectContent>
				</Select>
			</div>
		</div>
	);
}

function CrushModelSection({
	crushModel,
	onCrushModelChange,
	crushModels,
	disabled,
	labelClass,
	triggerClass,
}: {
	crushModel: CrushModelPick;
	onCrushModelChange: (v: CrushModelPick) => void;
	crushModels: string[];
	disabled?: boolean;
	labelClass: string;
	triggerClass: string;
}) {
	const grouped = groupByProvider(crushModels);

	return (
		<div className="flex flex-col gap-1.5">
			<Label className={labelClass}>Model</Label>
			<Select
				value={crushModel}
				onValueChange={(v) => onCrushModelChange(v)}
				disabled={disabled}
			>
				<SelectTrigger className={triggerClass}>
					<SelectValue />
				</SelectTrigger>
				<SelectContent className="max-h-64">
					<SelectItem value={DEFAULT_SENTINEL}>
						<span className="text-xs font-medium">デフォルト</span>
					</SelectItem>
					{Object.entries(grouped).map(([provider, models]) =>
						models.map((model) => (
							<SelectItem key={model} value={model}>
								<span className="text-xs font-medium">
									{model.replace(`${provider}/`, "")}
								</span>
								<span className="text-[10px] text-muted-foreground ml-1">
									{provider}
								</span>
							</SelectItem>
						)),
					)}
				</SelectContent>
			</Select>
		</div>
	);
}

function groupByProvider(models: string[]): Record<string, string[]> {
	const result: Record<string, string[]> = {};
	for (const model of models) {
		const sep = model.indexOf("/");
		const provider = sep > 0 ? model.slice(0, sep) : "other";
		if (!result[provider]) result[provider] = [];
		result[provider].push(model);
	}
	return result;
}
