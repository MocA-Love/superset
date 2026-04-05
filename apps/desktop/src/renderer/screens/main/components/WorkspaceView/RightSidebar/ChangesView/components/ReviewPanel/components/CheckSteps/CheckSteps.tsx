import { cn } from "@superset/ui/utils";
import { LuCheck, LuLoaderCircle, LuMinus, LuX } from "react-icons/lu";
import { VscCircle } from "react-icons/vsc";
import { electronTrpc } from "renderer/lib/electron-trpc";
import { useWorkspaceId } from "renderer/screens/main/components/WorkspaceView/WorkspaceIdContext";

interface CheckStepsProps {
	detailsUrl: string;
}

const stepIconConfig = {
	success: {
		icon: LuCheck,
		className: "text-emerald-600 dark:text-emerald-400",
	},
	failure: {
		icon: LuX,
		className: "text-red-600 dark:text-red-400",
	},
	in_progress: {
		icon: LuLoaderCircle,
		className: "text-amber-600 dark:text-amber-400",
	},
	skipped: {
		icon: LuMinus,
		className: "text-muted-foreground",
	},
	cancelled: {
		icon: LuMinus,
		className: "text-muted-foreground",
	},
	queued: {
		icon: VscCircle,
		className: "text-muted-foreground",
	},
} as const;

function getStepIcon(status: string, conclusion: string | null) {
	if (status === "completed") {
		if (conclusion === "success") return stepIconConfig.success;
		if (conclusion === "failure") return stepIconConfig.failure;
		if (conclusion === "skipped") return stepIconConfig.skipped;
		if (conclusion === "cancelled") return stepIconConfig.cancelled;
		return stepIconConfig.success;
	}
	if (status === "in_progress") return stepIconConfig.in_progress;
	return stepIconConfig.queued;
}

export function CheckSteps({ detailsUrl }: CheckStepsProps) {
	const workspaceId = useWorkspaceId();

	const { data: steps, isLoading } =
		electronTrpc.workspaces.getCheckJobSteps.useQuery(
			{ workspaceId: workspaceId ?? "", detailsUrl },
			{
				enabled: !!workspaceId && !!detailsUrl,
				staleTime: 5_000,
				refetchInterval: 5_000,
			},
		);

	if (isLoading) {
		return (
			<div className="px-3 py-1 text-[10px] text-muted-foreground">
				Loading steps...
			</div>
		);
	}

	if (!steps || steps.length === 0) {
		return (
			<div className="px-3 py-1 text-[10px] text-muted-foreground">
				No step details available.
			</div>
		);
	}

	return (
		<div className="pb-0.5">
			{steps.map(
				(step: {
					name: string;
					status: string;
					conclusion: string | null;
					number: number;
				}) => {
					const config = getStepIcon(step.status, step.conclusion);
					const StepIcon = config.icon;
					return (
						<div
							key={step.number}
							className="flex min-w-0 items-center gap-1 px-3 py-0.5 text-[11px]"
						>
							<StepIcon
								className={cn(
									"size-2.5 shrink-0",
									config.className,
									step.status === "in_progress" && "animate-spin",
								)}
							/>
							<span className="min-w-0 truncate text-muted-foreground">
								{step.name}
							</span>
						</div>
					);
				},
			)}
		</div>
	);
}
