import { Button } from "@superset/ui/button";
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from "@superset/ui/collapsible";
import {
	Dialog,
	DialogContent,
	DialogHeader,
	DialogTitle,
} from "@superset/ui/dialog";
import { ScrollArea, ScrollBar } from "@superset/ui/scroll-area";
import { toast } from "@superset/ui/sonner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@superset/ui/tooltip";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
	LuBox,
	LuBug,
	LuChevronRight,
	LuLoaderCircle,
	LuPlay,
	LuRefreshCw,
	LuSquareTerminal,
	LuSquareX,
	LuTrash2,
} from "react-icons/lu";
import type { ElectronRouterOutputs } from "renderer/lib/electron-trpc";
import { electronTrpc } from "renderer/lib/electron-trpc";
import { launchCommandInPane } from "renderer/lib/terminal/launch-command";
import { electronTrpcClient } from "renderer/lib/trpc-client";
import { useWorkspaceId } from "renderer/screens/main/components/WorkspaceView/WorkspaceIdContext";
import { useTabsStore } from "renderer/stores/tabs/store";
import { InspectCodeBlock } from "./components/InspectCodeBlock";

interface DockerViewProps {
	isActive?: boolean;
}

type DockerListResult = ElectronRouterOutputs["docker"]["list"];
type DockerComposeGroup = DockerListResult["composeFiles"][number];
type DockerContainer = DockerComposeGroup["containers"][number];

function quoteShellLiteral(value: string): string {
	return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function getContainerStateTone(container: DockerContainer): string {
	switch (container.state) {
		case "running":
			return "bg-emerald-500/10 text-emerald-400 border-emerald-500/20";
		case "exited":
			return "bg-muted text-muted-foreground border-border";
		default:
			return "bg-amber-500/10 text-amber-400 border-amber-500/20";
	}
}

function getComposeGroupTone(group: DockerComposeGroup): string {
	if (group.totalContainers === 0) {
		return "text-muted-foreground";
	}

	if (group.runningContainers === group.totalContainers) {
		return "text-emerald-400";
	}

	if (group.runningContainers === 0) {
		return "text-muted-foreground";
	}

	return "text-amber-400";
}

export function DockerView({ isActive = true }: DockerViewProps) {
	const workspaceId = useWorkspaceId();
	const utils = electronTrpc.useUtils();
	const addTab = useTabsStore((state) => state.addTab);
	const setPaneName = useTabsStore((state) => state.setPaneName);
	const setActiveTab = useTabsStore((state) => state.setActiveTab);
	const setFocusedPane = useTabsStore((state) => state.setFocusedPane);

	const [inspectContainerId, setInspectContainerId] = useState<string | null>(
		null,
	);
	const [expandedComposeGroups, setExpandedComposeGroups] = useState<
		Record<string, boolean>
	>({});

	const dockerListQuery = electronTrpc.docker.list.useQuery(
		{ workspaceId: workspaceId ?? "" },
		{
			enabled: Boolean(workspaceId) && isActive,
			refetchInterval: isActive ? 5000 : false,
			staleTime: 3000,
		},
	);

	const inspectQuery = electronTrpc.docker.inspectContainer.useQuery(
		{
			containerId: inspectContainerId ?? "",
			workspaceId: workspaceId ?? "",
		},
		{
			enabled: Boolean(workspaceId && inspectContainerId),
			staleTime: 0,
		},
	);

	const invalidateDockerQueries = useCallback(async () => {
		if (!workspaceId) {
			return;
		}

		await Promise.all([
			utils.docker.list.invalidate({ workspaceId }),
			utils.docker.getComposeFiles.invalidate({ workspaceId }),
		]);
	}, [utils, workspaceId]);

	const startProjectMutation = electronTrpc.docker.startProject.useMutation({
		onMutate: (variables) => {
			const message = variables.rebuild
				? "コンテナをリビルド中..."
				: "コンテナを起動中...";
			return { toastId: toast.loading(message) };
		},
		onSuccess: (_data, variables, context) => {
			const message = variables.rebuild
				? "リビルドが完了しました"
				: "起動しました";
			toast.success(message, { id: context?.toastId });
			void invalidateDockerQueries();
		},
		onError: (error, variables, context) => {
			const message = variables.rebuild
				? "リビルドに失敗しました"
				: "Docker compose up に失敗しました";
			toast.error(message, {
				id: context?.toastId,
				description: error.message,
			});
		},
	});

	const stopProjectMutation = electronTrpc.docker.stopProject.useMutation({
		onMutate: () => {
			return { toastId: toast.loading("コンテナを停止中...") };
		},
		onSuccess: (_data, _variables, context) => {
			toast.success("停止しました", { id: context?.toastId });
			void invalidateDockerQueries();
		},
		onError: (error, _variables, context) => {
			toast.error("Docker compose stop に失敗しました", {
				id: context?.toastId,
				description: error.message,
			});
		},
	});

	const removeProjectMutation = electronTrpc.docker.removeProject.useMutation({
		onMutate: () => {
			return { toastId: toast.loading("コンテナを削除中...") };
		},
		onSuccess: (_data, _variables, context) => {
			toast.success("削除しました", { id: context?.toastId });
			void invalidateDockerQueries();
		},
		onError: (error, _variables, context) => {
			toast.error("Docker compose down に失敗しました", {
				id: context?.toastId,
				description: error.message,
			});
		},
	});

	const startContainerMutation = electronTrpc.docker.startContainer.useMutation(
		{
			onSuccess: () => {
				void invalidateDockerQueries();
			},
			onError: (error) => {
				toast.error("コンテナの起動に失敗しました", {
					description: error.message,
				});
			},
		},
	);

	const stopContainerMutation = electronTrpc.docker.stopContainer.useMutation({
		onSuccess: () => {
			void invalidateDockerQueries();
		},
		onError: (error) => {
			toast.error("コンテナの停止に失敗しました", {
				description: error.message,
			});
		},
	});

	const restartContainerMutation =
		electronTrpc.docker.restartContainer.useMutation({
			onSuccess: () => {
				void invalidateDockerQueries();
			},
			onError: (error) => {
				toast.error("コンテナの再起動に失敗しました", {
					description: error.message,
				});
			},
		});

	const openCommandInTerminal = useCallback(
		async ({
			command,
			cwd,
			title,
		}: {
			command: string;
			cwd?: string;
			title: string;
		}) => {
			if (!workspaceId) {
				return;
			}

			const { paneId, tabId } = addTab(workspaceId, {
				initialCwd: cwd,
			});
			setPaneName(paneId, title);
			setActiveTab(workspaceId, tabId);
			setFocusedPane(tabId, paneId);

			try {
				await launchCommandInPane({
					paneId,
					tabId,
					workspaceId,
					command,
					cwd,
					createOrAttach: (input) =>
						electronTrpcClient.terminal.createOrAttach.mutate(input),
					write: (input) => electronTrpcClient.terminal.write.mutate(input),
				});
			} catch (error) {
				toast.error("Docker command のターミナル起動に失敗しました", {
					description: error instanceof Error ? error.message : "Unknown error",
				});
			}
		},
		[addTab, setActiveTab, setFocusedPane, setPaneName, workspaceId],
	);

	const handleOpenLogs = useCallback(
		async (container: DockerContainer, cwd?: string) => {
			await openCommandInTerminal({
				command: `docker logs -f --tail 200 ${quoteShellLiteral(container.id)}`,
				cwd,
				title: `Logs: ${container.name}`,
			});
		},
		[openCommandInTerminal],
	);

	const handleAttachShell = useCallback(
		async (container: DockerContainer, cwd?: string) => {
			await openCommandInTerminal({
				command: `docker exec -it ${quoteShellLiteral(
					container.id,
				)} sh -lc 'if command -v bash >/dev/null 2>&1; then exec bash -l; fi; exec sh'`,
				cwd,
				title: `Shell: ${container.name}`,
			});
		},
		[openCommandInTerminal],
	);

	const inspectJson = useMemo(() => {
		if (!inspectQuery.data) {
			return "";
		}

		return JSON.stringify(inspectQuery.data, null, 2);
	}, [inspectQuery.data]);

	useEffect(() => {
		const composeFiles = dockerListQuery.data?.composeFiles;
		if (!composeFiles) {
			return;
		}

		setExpandedComposeGroups((previous) => {
			const next: Record<string, boolean> = {};
			let changed = false;

			for (const group of composeFiles) {
				const existing = previous[group.absolutePath];
				next[group.absolutePath] = existing ?? true;
				if (existing === undefined) {
					changed = true;
				}
			}

			if (!changed && Object.keys(previous).length === composeFiles.length) {
				return previous;
			}

			return next;
		});
	}, [dockerListQuery.data?.composeFiles]);

	if (!workspaceId) {
		return null;
	}

	return (
		<>
			<div className="flex min-h-0 flex-1 flex-col overflow-hidden">
				<div className="flex items-center justify-between gap-2 border-b px-3 py-2">
					<div>
						<h2 className="text-sm font-medium">Docker</h2>
						<p className="text-xs text-muted-foreground">
							Compose files in this workspace
						</p>
					</div>
					<Button
						size="sm"
						variant="ghost"
						className="h-7 px-2"
						onClick={() => void dockerListQuery.refetch()}
						disabled={dockerListQuery.isFetching}
					>
						<LuRefreshCw
							className={`mr-1 size-3.5 ${dockerListQuery.isFetching ? "animate-spin" : ""}`}
						/>
						Refresh
					</Button>
				</div>

				<ScrollArea className="min-h-0 flex-1">
					{dockerListQuery.isLoading ? (
						<div className="p-3 text-sm text-muted-foreground">
							Docker 情報を読み込み中です。
						</div>
					) : null}

					{dockerListQuery.data && !dockerListQuery.data.dockerAvailable ? (
						<div className="m-3 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
							<div className="font-medium">Docker に接続できません</div>
							<div className="mt-1 text-xs text-destructive/80">
								{dockerListQuery.data.dockerError}
							</div>
						</div>
					) : null}

					{dockerListQuery.data &&
					dockerListQuery.data.composeFiles.length === 0 ? (
						<div className="p-3 text-sm text-muted-foreground">
							この workspace では compose file が見つかりませんでした。
						</div>
					) : null}

					<div className="space-y-3 p-3">
						{dockerListQuery.data?.composeFiles.map((group) => {
							const isExpanded =
								expandedComposeGroups[group.absolutePath] ?? true;

							return (
								<Collapsible
									key={group.absolutePath}
									open={isExpanded}
									onOpenChange={(open) => {
										setExpandedComposeGroups((previous) => ({
											...previous,
											[group.absolutePath]: open,
										}));
									}}
								>
									<div className="rounded-lg border bg-card/40">
										<div className="flex flex-col gap-2 border-b px-3 py-2">
											<div className="flex items-start justify-between gap-2">
												<CollapsibleTrigger asChild>
													<button
														type="button"
														className="flex min-w-0 flex-1 items-start gap-2 text-left"
													>
														<LuChevronRight
															className={`mt-0.5 size-4 shrink-0 text-muted-foreground transition-transform ${
																isExpanded ? "rotate-90" : ""
															}`}
														/>
														<div className="min-w-0">
															<div className="flex flex-wrap items-center gap-2">
																<LuBox className="size-4 shrink-0 text-muted-foreground" />
																<span className="truncate text-sm font-medium">
																	{group.projectName}
																</span>
																<span
																	className={`rounded-full border px-2 py-0.5 text-[10px] ${getComposeGroupTone(group)}`}
																>
																	{group.runningContainers}/
																	{group.totalContainers} running
																</span>
															</div>
															<div className="mt-1 text-xs text-muted-foreground">
																{group.relativePath}
															</div>
														</div>
													</button>
												</CollapsibleTrigger>
												<div className="flex items-center gap-1">
													{(() => {
														const isAllRunning =
															group.totalContainers > 0 &&
															group.runningContainers === group.totalContainers;
														const isAllStopped = group.runningContainers === 0;
														const isStartPending =
															startProjectMutation.isPending;
														const isStopPending = stopProjectMutation.isPending;
														const isRemovePending =
															removeProjectMutation.isPending;
														const isBusy =
															isStartPending ||
															isStopPending ||
															isRemovePending;

														return (
															<>
																<Tooltip>
																	<TooltipTrigger asChild>
																		<Button
																			size="icon"
																			variant="outline"
																			className="size-7"
																			onClick={() =>
																				startProjectMutation.mutate({
																					composeFilePath: group.absolutePath,
																					workspaceId,
																				})
																			}
																			disabled={isAllRunning || isBusy}
																		>
																			{isStartPending ? (
																				<LuLoaderCircle className="size-3.5 animate-spin" />
																			) : (
																				<LuPlay className="size-3.5" />
																			)}
																		</Button>
																	</TooltipTrigger>
																	<TooltipContent>Up</TooltipContent>
																</Tooltip>
																<Tooltip>
																	<TooltipTrigger asChild>
																		<Button
																			size="icon"
																			variant="outline"
																			className="size-7"
																			onClick={() =>
																				startProjectMutation.mutate({
																					composeFilePath: group.absolutePath,
																					workspaceId,
																					rebuild: true,
																				})
																			}
																			disabled={isBusy}
																		>
																			{isStartPending ? (
																				<LuLoaderCircle className="size-3.5 animate-spin" />
																			) : (
																				<LuRefreshCw className="size-3.5" />
																			)}
																		</Button>
																	</TooltipTrigger>
																	<TooltipContent>Rebuild</TooltipContent>
																</Tooltip>
																<Tooltip>
																	<TooltipTrigger asChild>
																		<Button
																			size="icon"
																			variant="outline"
																			className="size-7"
																			onClick={() =>
																				stopProjectMutation.mutate({
																					composeFilePath: group.absolutePath,
																					workspaceId,
																				})
																			}
																			disabled={isAllStopped || isBusy}
																		>
																			{isStopPending ? (
																				<LuLoaderCircle className="size-3.5 animate-spin" />
																			) : (
																				<LuSquareX className="size-3.5" />
																			)}
																		</Button>
																	</TooltipTrigger>
																	<TooltipContent>Stop</TooltipContent>
																</Tooltip>
																<Tooltip>
																	<TooltipTrigger asChild>
																		<Button
																			size="icon"
																			variant="outline"
																			className="size-7 text-destructive"
																			onClick={() =>
																				removeProjectMutation.mutate({
																					composeFilePath: group.absolutePath,
																					workspaceId,
																				})
																			}
																			disabled={
																				(isAllStopped &&
																					group.totalContainers === 0) ||
																				isBusy
																			}
																		>
																			{isRemovePending ? (
																				<LuLoaderCircle className="size-3.5 animate-spin" />
																			) : (
																				<LuTrash2 className="size-3.5" />
																			)}
																		</Button>
																	</TooltipTrigger>
																	<TooltipContent>Delete</TooltipContent>
																</Tooltip>
															</>
														);
													})()}
												</div>
											</div>
										</div>

										<CollapsibleContent className="overflow-hidden">
											{group.totalContainers === 0 ? (
												<div className="px-3 py-3 text-xs text-muted-foreground">
													まだコンテナは作成されていません。
												</div>
											) : (
												<div className="divide-y">
													{group.containers.map((container) => {
														const isRunning = container.state === "running";

														return (
															<div
																key={container.id}
																className="space-y-2 px-3 py-2"
															>
																<div className="flex flex-col gap-2">
																	<div className="min-w-0">
																		<div className="flex flex-wrap items-center gap-2">
																			<span className="truncate text-sm font-medium">
																				{container.name}
																			</span>
																			<span
																				className={`rounded-full border px-2 py-0.5 text-[10px] ${getContainerStateTone(
																					container,
																				)}`}
																			>
																				{container.state}
																			</span>
																		</div>
																		<div className="mt-1 break-all text-xs text-muted-foreground">
																			{container.service
																				? `${container.service} · `
																				: ""}
																			{container.image}
																		</div>
																		<div className="mt-1 text-xs text-muted-foreground">
																			{container.status}
																		</div>
																		{container.ports ? (
																			<div className="mt-1 text-[11px] text-muted-foreground">
																				Ports: {container.ports}
																			</div>
																		) : null}
																	</div>
																	<div className="flex flex-wrap items-center gap-1">
																		{isRunning ? (
																			<Button
																				size="sm"
																				variant="outline"
																				className="h-7 px-2 whitespace-normal"
																				onClick={() =>
																					stopContainerMutation.mutate({
																						containerId: container.id,
																						workspaceId,
																					})
																				}
																				disabled={
																					stopContainerMutation.isPending
																				}
																			>
																				Stop
																			</Button>
																		) : (
																			<Button
																				size="sm"
																				variant="outline"
																				className="h-7 px-2 whitespace-normal"
																				onClick={() =>
																					startContainerMutation.mutate({
																						containerId: container.id,
																						workspaceId,
																					})
																				}
																				disabled={
																					startContainerMutation.isPending
																				}
																			>
																				Start
																			</Button>
																		)}
																		<Button
																			size="sm"
																			variant="outline"
																			className="h-7 px-2 whitespace-normal"
																			onClick={() =>
																				restartContainerMutation.mutate({
																					containerId: container.id,
																					workspaceId,
																				})
																			}
																			disabled={
																				restartContainerMutation.isPending
																			}
																		>
																			Restart
																		</Button>
																		<Button
																			size="sm"
																			variant="outline"
																			className="h-7 px-2 whitespace-normal"
																			onClick={() =>
																				void handleOpenLogs(
																					container,
																					group.directoryPath,
																				)
																			}
																		>
																			<LuSquareTerminal className="mr-1 size-3.5" />
																			Logs
																		</Button>
																		<Button
																			size="sm"
																			variant="outline"
																			className="h-7 px-2 whitespace-normal"
																			onClick={() =>
																				void handleAttachShell(
																					container,
																					group.directoryPath,
																				)
																			}
																			disabled={!isRunning}
																		>
																			Shell
																		</Button>
																		<Button
																			size="sm"
																			variant="outline"
																			className="h-7 px-2 whitespace-normal"
																			onClick={() =>
																				setInspectContainerId(container.id)
																			}
																		>
																			<LuBug className="mr-1 size-3.5" />
																			Inspect
																		</Button>
																	</div>
																</div>
															</div>
														);
													})}
												</div>
											)}
										</CollapsibleContent>
									</div>
								</Collapsible>
							);
						})}
					</div>
					<ScrollBar orientation="vertical" />
				</ScrollArea>
			</div>

			<Dialog
				open={inspectContainerId !== null}
				onOpenChange={(open) => {
					if (!open) {
						setInspectContainerId(null);
					}
				}}
			>
				<DialogContent className="!w-[min(96vw,1600px)] !max-w-[min(96vw,1600px)] sm:!max-w-[min(96vw,1600px)]">
					<DialogHeader>
						<DialogTitle>Container Inspect</DialogTitle>
					</DialogHeader>
					<div className="max-h-[70vh] w-full max-w-full overflow-x-auto overflow-y-auto rounded-md border bg-muted/20 [scrollbar-gutter:stable]">
						{inspectQuery.isLoading ? (
							<div className="p-4 text-sm text-muted-foreground">
								Inspect を読み込み中です。
							</div>
						) : inspectQuery.error ? (
							<div className="p-4 text-sm text-destructive">
								{inspectQuery.error.message}
							</div>
						) : (
							<InspectCodeBlock code={inspectJson} language="json" />
						)}
					</div>
				</DialogContent>
			</Dialog>
		</>
	);
}
