import { Badge } from "@superset/ui/badge";
import { Button } from "@superset/ui/button";
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from "@superset/ui/collapsible";
import {
	ContextMenu,
	ContextMenuContent,
	ContextMenuItem,
	ContextMenuTrigger,
} from "@superset/ui/context-menu";
import {
	Empty,
	EmptyContent,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from "@superset/ui/empty";
import { ScrollArea } from "@superset/ui/scroll-area";
import { toast } from "@superset/ui/sonner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@superset/ui/tooltip";
import { cn } from "@superset/ui/utils";
import { useMemo, useState } from "react";
import {
	LuChevronDown,
	LuChevronRight,
	LuCircleAlert,
	LuClipboard,
	LuCopy,
	LuInfo,
	LuRefreshCw,
	LuTriangleAlert,
} from "react-icons/lu";
import { electronTrpc } from "renderer/lib/electron-trpc";
import { useWorkspaceId } from "renderer/screens/main/components/WorkspaceView/WorkspaceIdContext";

type ProblemItem = {
	providerId: string;
	absolutePath: string | null;
	relativePath: string | null;
	line: number | null;
	column: number | null;
	endLine: number | null;
	endColumn: number | null;
	message: string;
	code: string | number | null;
	severity: "error" | "warning" | "info" | "hint";
	source: string;
	relatedInformation?: Array<{
		absolutePath: string | null;
		relativePath: string | null;
		line: number | null;
		column: number | null;
		endLine: number | null;
		endColumn: number | null;
		message: string;
	}>;
};

function severityLabel(severity: ProblemItem["severity"]): string {
	switch (severity) {
		case "error":
			return "Error";
		case "warning":
			return "Warning";
		case "info":
			return "Info";
		case "hint":
		default:
			return "Hint";
	}
}

function severityIcon(severity: ProblemItem["severity"]) {
	switch (severity) {
		case "error":
			return (
				<LuCircleAlert className="size-3.5 shrink-0 text-red-500" />
			);
		case "warning":
			return (
				<LuTriangleAlert className="size-3.5 shrink-0 text-amber-500" />
			);
		case "info":
		case "hint":
		default:
			return <LuInfo className="size-3.5 shrink-0 text-blue-500" />;
	}
}

function severityToMarkerSeverity(severity: ProblemItem["severity"]): number {
	switch (severity) {
		case "error":
			return 8;
		case "warning":
			return 4;
		case "info":
			return 2;
		case "hint":
		default:
			return 1;
	}
}

function normalizeSource(source: string): string {
	return source === "typescript" ? "ts" : source;
}

function buildClipboardPayload(problem: ProblemItem) {
	return [
		{
			resource: problem.absolutePath ?? problem.relativePath ?? "",
			owner: problem.providerId,
			code: problem.code !== null ? String(problem.code) : "",
			severity: severityToMarkerSeverity(problem.severity),
			message: problem.message,
			source: normalizeSource(problem.source),
			startLineNumber: problem.line ?? 1,
			startColumn: problem.column ?? 1,
			endLineNumber: problem.endLine ?? problem.line ?? 1,
			endColumn: problem.endColumn ?? problem.column ?? 1,
			relatedInformation:
				problem.relatedInformation?.map((item) => ({
					startLineNumber: item.line ?? 1,
					startColumn: item.column ?? 1,
					endLineNumber: item.endLine ?? item.line ?? 1,
					endColumn: item.endColumn ?? item.column ?? 1,
					message: item.message,
					resource: item.absolutePath ?? item.relativePath ?? "",
				})) ?? [],
			origin: "extHost1",
		},
	];
}

async function copyToClipboard(text: string, successMessage: string) {
	await navigator.clipboard.writeText(text);
	toast.success(successMessage);
}

function TruncatedWithTooltip({
	children,
	tooltip,
	className,
}: {
	children: string;
	tooltip?: string;
	className?: string;
}) {
	return (
		<Tooltip delayDuration={400}>
			<TooltipTrigger asChild>
				<span className={cn("block truncate", className)}>{children}</span>
			</TooltipTrigger>
			<TooltipContent side="top" align="start" className="max-w-[420px] text-xs">
				<p className="whitespace-pre-wrap break-words">{tooltip ?? children}</p>
			</TooltipContent>
		</Tooltip>
	);
}

export function ProblemsView({
	isActive,
	onOpenFileAtLine,
}: {
	isActive: boolean;
	onOpenFileAtLine: (path: string, line?: number) => void;
}) {
	const workspaceId = useWorkspaceId();
	const trpcUtils = electronTrpc.useUtils();
	const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({});

	const { data, isLoading, isFetching, refetch } =
		electronTrpc.languageServices.getWorkspaceDiagnostics.useQuery(
			{ workspaceId: workspaceId ?? "" },
			{
				enabled: isActive && Boolean(workspaceId),
				staleTime: Infinity,
			},
		);

	console.log("[ProblemsView] workspace diagnostics state", {
		workspaceId,
		isActive,
		isLoading,
		isFetching,
		totalCount: data?.totalCount ?? null,
		providers: data?.providers ?? [],
		problemFiles:
			data?.problems.map((problem) => problem.relativePath ?? "Workspace") ?? [],
	});

	const refreshDiagnostics =
		electronTrpc.languageServices.refreshWorkspace.useMutation({
			onSuccess: async (_data, variables) => {
				await trpcUtils.languageServices.getWorkspaceDiagnostics.invalidate({
					workspaceId: variables.workspaceId,
				});
			},
		});

	electronTrpc.languageServices.subscribeDiagnostics.useSubscription(
		{ workspaceId: workspaceId ?? "" },
		{
			enabled: Boolean(workspaceId),
			onData: () => {
				if (!workspaceId) {
					return;
				}
				console.log("[ProblemsView] subscribeDiagnostics event", {
					workspaceId,
				});
				void trpcUtils.languageServices.getWorkspaceDiagnostics.invalidate({
					workspaceId,
				});
			},
		},
	);

	const groupedProblems = useMemo(() => {
		const groups = new Map<string, ProblemItem[]>();
		for (const problem of data?.problems ?? []) {
			const groupKey = problem.relativePath ?? "Workspace";
			const existing = groups.get(groupKey);
			if (existing) {
				existing.push(problem);
			} else {
				groups.set(groupKey, [problem]);
			}
		}

		return Array.from(groups.entries()).map(([groupKey, problems]) => ({
			groupKey,
			problems,
		}));
	}, [data?.problems]);

	return (
		<div className="flex h-full min-h-0 flex-col overflow-hidden">
			<div className="border-b px-3 py-2">
				<div className="flex items-center justify-between gap-2">
					<div className="flex min-w-0 items-center gap-2">
						<Badge variant="destructive">{data?.summary.errorCount ?? 0}</Badge>
						<Badge variant="secondary">{data?.summary.warningCount ?? 0}</Badge>
						<Badge variant="outline">{data?.totalCount ?? 0} total</Badge>
					</div>
					<Button
						type="button"
						variant="ghost"
						size="icon"
						className="size-7 shrink-0"
						onClick={() => {
							if (!workspaceId) {
								return;
							}
							void refreshDiagnostics.mutateAsync({ workspaceId });
							void refetch();
						}}
						disabled={isFetching || refreshDiagnostics.isPending}
					>
						<LuRefreshCw
							className={cn(
								"size-3.5",
								(isFetching || refreshDiagnostics.isPending) && "animate-spin",
							)}
						/>
					</Button>
				</div>
				{data?.providers?.length ? (
					<p className="text-muted-foreground mt-2 truncate text-xs">
						{data.providers
							.map((provider) =>
								provider.details
									? `${provider.label}: ${provider.details}`
									: `${provider.label}: ${provider.documentCount} files`,
							)
							.join(" / ")}
					</p>
				) : null}
			</div>

			<ScrollArea className="min-h-0 flex-1">
				{isLoading ? (
					<div className="text-muted-foreground px-3 py-4 text-sm">
						Collecting diagnostics...
					</div>
				) : (data?.problems.length ?? 0) === 0 ? (
					<Empty className="h-full min-h-[220px]">
						<EmptyHeader>
							<EmptyMedia variant="icon">
								<LuTriangleAlert className="size-5" />
							</EmptyMedia>
							<EmptyTitle>No Problems</EmptyTitle>
							<EmptyDescription>
								No diagnostics were found in the currently open TypeScript or
								JavaScript files.
							</EmptyDescription>
						</EmptyHeader>
						<EmptyContent />
					</Empty>
				) : (
					<div className="divide-y">
						{groupedProblems.map(({ groupKey, problems }) => (
							<Collapsible
								key={groupKey}
								open={openGroups[groupKey] ?? true}
								onOpenChange={(open) => {
									setOpenGroups((current) => ({
										...current,
										[groupKey]: open,
									}));
								}}
								className="px-3 py-2"
							>
								<div className="mb-1 flex min-w-0 items-center justify-between gap-2">
									<CollapsibleTrigger className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden text-left">
										{(openGroups[groupKey] ?? true) ? (
											<LuChevronDown className="text-muted-foreground size-3.5 shrink-0" />
										) : (
											<LuChevronRight className="text-muted-foreground size-3.5 shrink-0" />
										)}
										<TruncatedWithTooltip
											className="text-xs font-medium"
											tooltip={groupKey}
										>
											{groupKey}
										</TruncatedWithTooltip>
									</CollapsibleTrigger>
									<span className="text-muted-foreground shrink-0 text-[11px]">
										{problems.length}
									</span>
								</div>
								<CollapsibleContent className="space-y-0.5">
									{problems.map((problem, index) => {
										const canOpen = Boolean(problem.relativePath);
										return (
											<ContextMenu
												key={`${groupKey}:${problem.code ?? "no-code"}:${problem.line ?? 0}:${index}`}
											>
												<ContextMenuTrigger asChild>
													<button
														type="button"
														disabled={!canOpen}
														onClick={() => {
															if (problem.relativePath) {
																onOpenFileAtLine(
																	problem.relativePath,
																	problem.line ?? undefined,
																);
															}
														}}
														className={cn(
															"group w-full rounded-sm px-1.5 py-1 text-left transition-colors",
															canOpen
																? "hover:bg-muted/60"
																: "cursor-default opacity-90",
														)}
													>
														<div className="flex items-start gap-2">
															<div className="pt-0.5">
																{severityIcon(problem.severity)}
															</div>
															<div className="min-w-0 flex-1">
																<TruncatedWithTooltip
																	className="text-xs leading-5"
																	tooltip={problem.message}
																>
																	{problem.message}
																</TruncatedWithTooltip>
																<div className="text-muted-foreground flex items-center gap-2 overflow-hidden text-[11px] leading-4">
																	<span className="shrink-0">
																		{severityLabel(problem.severity)}
																	</span>
																	<TruncatedWithTooltip
																		className="min-w-0 flex-1"
																		tooltip={
																			problem.code !== null
																				? `${normalizeSource(problem.source)}(${problem.code})`
																				: normalizeSource(problem.source)
																		}
																	>
																		{problem.code !== null
																			? `${normalizeSource(problem.source)}(${problem.code})`
																			: normalizeSource(problem.source)}
																	</TruncatedWithTooltip>
																	{problem.line !== null ? (
																		<span className="shrink-0">
																			[Ln {problem.line}
																			{problem.column !== null
																				? `, Col ${problem.column}`
																				: ""}
																			]
																		</span>
																	) : null}
																</div>
															</div>
														</div>
													</button>
												</ContextMenuTrigger>
												<ContextMenuContent>
													<ContextMenuItem
														onSelect={() => {
															void copyToClipboard(
																problem.message,
																"Problem message copied",
															);
														}}
													>
														<LuClipboard className="mr-2 size-4" />
														メッセージをコピー
													</ContextMenuItem>
													<ContextMenuItem
														onSelect={() => {
															void copyToClipboard(
																JSON.stringify(
																	buildClipboardPayload(problem),
																	null,
																	"\t",
																),
																"Problem copied",
															);
														}}
													>
														<LuCopy className="mr-2 size-4" />
														コピー
													</ContextMenuItem>
												</ContextMenuContent>
											</ContextMenu>
										);
									})}
								</CollapsibleContent>
							</Collapsible>
						))}
						{data?.truncated ? (
							<div className="text-muted-foreground px-3 py-3 text-xs">
								Showing the first {data.problems.length} problems out of{" "}
								{data.totalCount}.
							</div>
						) : null}
					</div>
				)}
			</ScrollArea>
		</div>
	);
}
