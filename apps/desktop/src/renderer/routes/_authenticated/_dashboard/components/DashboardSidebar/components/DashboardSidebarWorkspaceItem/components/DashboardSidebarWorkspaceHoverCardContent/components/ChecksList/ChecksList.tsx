import { useState } from "react";
import { LuChevronDown, LuChevronRight } from "react-icons/lu";
import { STROKE_WIDTH } from "renderer/screens/main/components/WorkspaceSidebar/constants";
import type { DashboardSidebarWorkspacePullRequestCheck } from "../../../../../../types";
import { CheckItemRow } from "./components/CheckItemRow";

interface ChecksListProps {
	checks: DashboardSidebarWorkspacePullRequestCheck[];
}

function getCheckKey(
	check: DashboardSidebarWorkspacePullRequestCheck,
	index: number,
): string {
	return `${check.name}:${check.url ?? "no-url"}:${index}`;
}

export function ChecksList({ checks }: ChecksListProps) {
	const [expanded, setExpanded] = useState(false);

	const relevantChecks = checks.filter(
		(check) => check.status !== "skipped" && check.status !== "cancelled",
	);

	if (relevantChecks.length === 0) return null;

	return (
		<div className="text-xs">
			<button
				type="button"
				onClick={() => setExpanded(!expanded)}
				className="flex items-center gap-1 text-muted-foreground hover:text-foreground transition-colors"
			>
				{expanded ? (
					<LuChevronDown className="size-3" strokeWidth={STROKE_WIDTH} />
				) : (
					<LuChevronRight className="size-3" strokeWidth={STROKE_WIDTH} />
				)}
				<span>{expanded ? "Hide checks" : "Show checks"}</span>
			</button>

			{expanded && (
				<div className="mt-1.5 space-y-1 pl-1">
					{relevantChecks.map((check, index) => (
						<CheckItemRow key={getCheckKey(check, index)} check={check} />
					))}
				</div>
			)}
		</div>
	);
}
