import {
	type BranchPrefixMode,
	sanitizeSegment,
} from "@superset/shared/workspace-launch";
import { Input } from "@superset/ui/input";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@superset/ui/select";
import { useEffect, useState } from "react";
import {
	BRANCH_PREFIX_MODE_LABELS,
	BRANCH_PREFIX_MODE_LABELS_WITH_DEFAULT,
} from "../../utils/branch-prefix";

const DEFAULT_VALUE = "default";

export type BranchPrefixControlMode = BranchPrefixMode | null;

interface BranchPrefixControlProps {
	mode: BranchPrefixControlMode;
	customPrefix: string | null;
	showDefault?: boolean;
	disabled?: boolean;
	onChange: (next: {
		mode: BranchPrefixControlMode;
		customPrefix: string | null;
	}) => void;
}

export function BranchPrefixControl({
	mode,
	customPrefix,
	showDefault = false,
	disabled,
	onChange,
}: BranchPrefixControlProps) {
	const [customPrefixInput, setCustomPrefixInput] = useState(
		customPrefix ?? "",
	);
	useEffect(() => {
		setCustomPrefixInput(customPrefix ?? "");
	}, [customPrefix]);

	const selectValue = mode ?? DEFAULT_VALUE;
	const labels = showDefault
		? BRANCH_PREFIX_MODE_LABELS_WITH_DEFAULT
		: BRANCH_PREFIX_MODE_LABELS;

	const handleModeChange = (value: string) => {
		const nextMode: BranchPrefixControlMode =
			value === DEFAULT_VALUE ? null : (value as BranchPrefixMode);
		onChange({ mode: nextMode, customPrefix: customPrefixInput || null });
	};

	const handleCustomPrefixBlur = () => {
		const sanitized = sanitizeSegment(customPrefixInput);
		setCustomPrefixInput(sanitized);
		if (!sanitized) return;
		onChange({ mode: "custom", customPrefix: sanitized });
	};

	return (
		<div className="flex items-center gap-2">
			<Select
				value={selectValue}
				onValueChange={handleModeChange}
				disabled={disabled}
			>
				<SelectTrigger className={showDefault ? "w-[200px]" : "w-[180px]"}>
					<SelectValue />
				</SelectTrigger>
				<SelectContent>
					{Object.entries(labels).map(([value, label]) => (
						<SelectItem key={value} value={value}>
							{label}
						</SelectItem>
					))}
				</SelectContent>
			</Select>
			{selectValue === "custom" && (
				<Input
					placeholder="Prefix"
					value={customPrefixInput}
					onChange={(event) => setCustomPrefixInput(event.target.value)}
					onBlur={handleCustomPrefixBlur}
					className="w-[120px]"
					disabled={disabled}
				/>
			)}
		</div>
	);
}
