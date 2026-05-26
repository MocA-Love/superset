import type { FileOpenMode } from "@superset/local-db";
import { Input } from "@superset/ui/input";
import { Label } from "@superset/ui/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@superset/ui/select";
import { Switch } from "@superset/ui/switch";
import {
	type FocusEvent,
	useCallback,
	useEffect,
	useRef,
	useState,
} from "react";
import { electronTrpc } from "renderer/lib/electron-trpc";
import {
	clampRightSidebarOpenViewWidth,
	DEFAULT_RIGHT_SIDEBAR_OPEN_VIEW_WIDTH,
	MAX_RIGHT_SIDEBAR_OPEN_VIEW_WIDTH,
	MIN_RIGHT_SIDEBAR_OPEN_VIEW_WIDTH,
} from "shared/constants";
import {
	isItemVisible,
	SETTING_ITEM_ID,
	type SettingItemId,
} from "../../../utils/settings-search";

interface BehaviorSettingsProps {
	visibleItems?: SettingItemId[] | null;
}

export function BehaviorSettings({ visibleItems }: BehaviorSettingsProps) {
	const showConfirmQuit = isItemVisible(
		SETTING_ITEM_ID.BEHAVIOR_CONFIRM_QUIT,
		visibleItems,
	);
	const showFileOpenMode = isItemVisible(
		SETTING_ITEM_ID.BEHAVIOR_FILE_OPEN_MODE,
		visibleItems,
	);
	const showRightSidebarOpenViewWidth = isItemVisible(
		SETTING_ITEM_ID.BEHAVIOR_RIGHT_SIDEBAR_OPEN_VIEW_WIDTH,
		visibleItems,
	);
	const showResourceMonitor = isItemVisible(
		SETTING_ITEM_ID.BEHAVIOR_RESOURCE_MONITOR,
		visibleItems,
	);
	const showOpenLinksInApp = isItemVisible(
		SETTING_ITEM_ID.BEHAVIOR_OPEN_LINKS_IN_APP,
		visibleItems,
	);

	const utils = electronTrpc.useUtils();

	const { data: confirmOnQuit, isLoading: isConfirmLoading } =
		electronTrpc.settings.getConfirmOnQuit.useQuery();
	const setConfirmOnQuit = electronTrpc.settings.setConfirmOnQuit.useMutation({
		onMutate: async ({ enabled }) => {
			await utils.settings.getConfirmOnQuit.cancel();
			const previous = utils.settings.getConfirmOnQuit.getData();
			utils.settings.getConfirmOnQuit.setData(undefined, enabled);
			return { previous };
		},
		onError: (_err, _vars, context) => {
			if (context?.previous !== undefined) {
				utils.settings.getConfirmOnQuit.setData(undefined, context.previous);
			}
		},
		onSettled: () => {
			utils.settings.getConfirmOnQuit.invalidate();
		},
	});

	const handleConfirmToggle = (enabled: boolean) => {
		setConfirmOnQuit.mutate({ enabled });
	};

	const { data: fileOpenMode, isLoading: isFileOpenModeLoading } =
		electronTrpc.settings.getFileOpenMode.useQuery();
	const setFileOpenMode = electronTrpc.settings.setFileOpenMode.useMutation({
		onMutate: async ({ mode }) => {
			await utils.settings.getFileOpenMode.cancel();
			const previous = utils.settings.getFileOpenMode.getData();
			utils.settings.getFileOpenMode.setData(undefined, mode);
			return { previous };
		},
		onError: (_err, _vars, context) => {
			if (context?.previous !== undefined) {
				utils.settings.getFileOpenMode.setData(undefined, context.previous);
			}
		},
		onSettled: () => {
			utils.settings.getFileOpenMode.invalidate();
		},
	});

	const { data: resourceMonitorEnabled, isLoading: isResourceMonitorLoading } =
		electronTrpc.settings.getShowResourceMonitor.useQuery();
	const setShowResourceMonitor =
		electronTrpc.settings.setShowResourceMonitor.useMutation({
			onMutate: async ({ enabled }) => {
				await utils.settings.getShowResourceMonitor.cancel();
				const previous = utils.settings.getShowResourceMonitor.getData();
				utils.settings.getShowResourceMonitor.setData(undefined, enabled);
				return { previous };
			},
			onError: (_err, _vars, context) => {
				if (context?.previous !== undefined) {
					utils.settings.getShowResourceMonitor.setData(
						undefined,
						context.previous,
					);
				}
			},
			onSettled: () => {
				utils.settings.getShowResourceMonitor.invalidate();
			},
		});

	const { data: openLinksInApp, isLoading: isOpenLinksInAppLoading } =
		electronTrpc.settings.getOpenLinksInApp.useQuery();
	const setOpenLinksInApp = electronTrpc.settings.setOpenLinksInApp.useMutation(
		{
			onMutate: async ({ enabled }) => {
				await utils.settings.getOpenLinksInApp.cancel();
				const previous = utils.settings.getOpenLinksInApp.getData();
				utils.settings.getOpenLinksInApp.setData(undefined, enabled);
				return { previous };
			},
			onError: (_err, _vars, context) => {
				if (context?.previous !== undefined) {
					utils.settings.getOpenLinksInApp.setData(undefined, context.previous);
				}
			},
			onSettled: () => {
				utils.settings.getOpenLinksInApp.invalidate();
			},
		},
	);

	const {
		data: rightSidebarOpenViewWidth,
		isLoading: isRightSidebarOpenViewWidthLoading,
	} = electronTrpc.settings.getRightSidebarOpenViewWidth.useQuery();
	const setRightSidebarOpenViewWidth =
		electronTrpc.settings.setRightSidebarOpenViewWidth.useMutation({
			onMutate: async ({ width }) => {
				await utils.settings.getRightSidebarOpenViewWidth.cancel();
				const previous = utils.settings.getRightSidebarOpenViewWidth.getData();
				utils.settings.getRightSidebarOpenViewWidth.setData(undefined, width);
				return { previous };
			},
			onError: (_err, _vars, context) => {
				if (context?.previous !== undefined) {
					utils.settings.getRightSidebarOpenViewWidth.setData(
						undefined,
						context.previous,
					);
				}
			},
			onSettled: () => {
				utils.settings.getRightSidebarOpenViewWidth.invalidate();
			},
		});
	const [rightSidebarOpenViewWidthDraft, setRightSidebarOpenViewWidthDraft] =
		useState<string | null>(null);
	const previousRightSidebarOpenViewWidthRef = useRef(
		rightSidebarOpenViewWidth,
	);

	useEffect(() => {
		if (
			previousRightSidebarOpenViewWidthRef.current === rightSidebarOpenViewWidth
		) {
			return;
		}
		previousRightSidebarOpenViewWidthRef.current = rightSidebarOpenViewWidth;
		setRightSidebarOpenViewWidthDraft(null);
	}, [rightSidebarOpenViewWidth]);

	const handleRightSidebarOpenViewWidthBlur = useCallback(
		(event: FocusEvent<HTMLInputElement>) => {
			const parsedWidth = Number.parseInt(event.target.value, 10);
			if (Number.isNaN(parsedWidth)) {
				setRightSidebarOpenViewWidthDraft(null);
				return;
			}

			const nextWidth = clampRightSidebarOpenViewWidth(parsedWidth);
			if (nextWidth !== rightSidebarOpenViewWidth) {
				setRightSidebarOpenViewWidth.mutate({ width: nextWidth });
			}
			setRightSidebarOpenViewWidthDraft(null);
		},
		[rightSidebarOpenViewWidth, setRightSidebarOpenViewWidth],
	);

	return (
		<div className="p-6 max-w-4xl w-full">
			<div className="mb-8">
				<h2 className="text-xl font-semibold">General</h2>
				<p className="text-sm text-muted-foreground mt-1">
					Configure general app preferences
				</p>
			</div>

			<div className="space-y-6">
				{showConfirmQuit && (
					<div className="flex items-center justify-between">
						<div className="space-y-0.5">
							<Label htmlFor="confirm-on-quit" className="text-sm font-medium">
								Confirm before quitting
							</Label>
							<p className="text-xs text-muted-foreground">
								Show a confirmation dialog when quitting the app
							</p>
						</div>
						<Switch
							id="confirm-on-quit"
							checked={confirmOnQuit ?? true}
							onCheckedChange={handleConfirmToggle}
							disabled={isConfirmLoading || setConfirmOnQuit.isPending}
						/>
					</div>
				)}

				{showFileOpenMode && (
					<div className="flex items-center justify-between">
						<div className="space-y-0.5">
							<Label className="text-sm font-medium">File open mode</Label>
							<p className="text-xs text-muted-foreground">
								Choose how files open when no preview pane exists
							</p>
						</div>
						<Select
							value={fileOpenMode ?? "split-pane"}
							onValueChange={(value) =>
								setFileOpenMode.mutate({ mode: value as FileOpenMode })
							}
							disabled={isFileOpenModeLoading || setFileOpenMode.isPending}
						>
							<SelectTrigger className="w-[180px]">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								<SelectItem value="split-pane">Split pane</SelectItem>
								<SelectItem value="new-tab">New tab</SelectItem>
							</SelectContent>
						</Select>
					</div>
				)}

				{showRightSidebarOpenViewWidth && (
					<div className="flex items-center justify-between gap-6">
						<div className="space-y-0.5">
							<Label
								htmlFor="right-sidebar-open-view-width"
								className="text-sm font-medium"
							>
								Right sidebar open view width
							</Label>
							<p className="text-xs text-muted-foreground">
								Initial width for new file and diff views opened from the Files
								or Git sidebar
							</p>
						</div>
						<div className="flex items-center gap-2">
							<Input
								id="right-sidebar-open-view-width"
								type="number"
								min={MIN_RIGHT_SIDEBAR_OPEN_VIEW_WIDTH}
								max={MAX_RIGHT_SIDEBAR_OPEN_VIEW_WIDTH}
								value={
									rightSidebarOpenViewWidthDraft ??
									String(
										rightSidebarOpenViewWidth ??
											DEFAULT_RIGHT_SIDEBAR_OPEN_VIEW_WIDTH,
									)
								}
								onChange={(event) =>
									setRightSidebarOpenViewWidthDraft(event.target.value)
								}
								onBlur={handleRightSidebarOpenViewWidthBlur}
								disabled={
									isRightSidebarOpenViewWidthLoading ||
									setRightSidebarOpenViewWidth.isPending
								}
								className="w-24"
							/>
							<span className="text-sm text-muted-foreground">%</span>
						</div>
					</div>
				)}

				{showResourceMonitor && (
					<div className="flex items-center justify-between">
						<div className="space-y-0.5">
							<Label htmlFor="resource-monitor" className="text-sm font-medium">
								Resource monitor
							</Label>
							<p className="text-xs text-muted-foreground">
								Show CPU and memory usage in the top bar
							</p>
						</div>
						<Switch
							id="resource-monitor"
							checked={resourceMonitorEnabled ?? false}
							onCheckedChange={(enabled) =>
								setShowResourceMonitor.mutate({ enabled })
							}
							disabled={
								isResourceMonitorLoading || setShowResourceMonitor.isPending
							}
						/>
					</div>
				)}

				{showOpenLinksInApp && (
					<div className="flex items-center justify-between">
						<div className="space-y-0.5">
							<Label
								htmlFor="open-links-in-app"
								className="text-sm font-medium"
							>
								Open links in the in-app browser
							</Label>
							<p className="text-xs text-muted-foreground">
								Open links from chat and terminal in the in-app browser instead
								of your default browser
							</p>
						</div>
						<Switch
							id="open-links-in-app"
							checked={openLinksInApp ?? false}
							onCheckedChange={(enabled) =>
								setOpenLinksInApp.mutate({ enabled })
							}
							disabled={isOpenLinksInAppLoading || setOpenLinksInApp.isPending}
						/>
					</div>
				)}
			</div>
		</div>
	);
}
