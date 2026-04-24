import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "@superset/ui/alert-dialog";
import { Button } from "@superset/ui/button";
import { toast } from "@superset/ui/sonner";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@superset/ui/table";
import { cn } from "@superset/ui/utils";
import { useMemo, useState } from "react";
import {
	HiOutlinePencilSquare,
	HiOutlinePlus,
	HiOutlineSquares2X2,
	HiOutlineTrash,
} from "react-icons/hi2";
import { electronTrpc } from "renderer/lib/electron-trpc";
import {
	formatCheckedAt,
	LEVEL_DOT_CLASS,
	LEVEL_LABEL,
} from "renderer/lib/service-status/level-display";
import { ServiceStatusIcon } from "renderer/lib/service-status/ServiceStatusIcon";
import { normalizeApiUrl } from "renderer/lib/service-status/service-presets";
import type {
	ServiceStatusDefinition,
	ServiceStatusSnapshot,
} from "shared/service-status-types";
import {
	isItemVisible,
	SETTING_ITEM_ID,
	type SettingItemId,
} from "../../../utils/settings-search/settings-search";
import { ServiceDefinitionDialog } from "./components/ServiceDefinitionDialog";
import { ServicePresetDialog } from "./components/ServicePresetDialog";

interface ServiceStatusSettingsProps {
	visibleItems: SettingItemId[] | null;
}

export function ServiceStatusSettings({
	visibleItems,
}: ServiceStatusSettingsProps) {
	// Live status snapshots (keyed by id) so the dashboard shows the same
	// dot + description the TopBar popover renders.
	const [snapshots, setSnapshots] = useState<
		Map<string, ServiceStatusSnapshot>
	>(() => new Map());

	// Definitions come from the same subscription that emits a fresh list on
	// connect and again after every CRUD mutation. Using a query alongside it
	// caused a transient mismatch between "snapshots already updated" and
	// "list still stale", which showed up as a one-frame flicker when
	// adding/removing rows.
	const [definitions, setDefinitions] = useState<ServiceStatusDefinition[]>([]);

	electronTrpc.serviceStatus.onChange.useSubscription(undefined, {
		onData: (event) => {
			if ("removedId" in event) {
				const removedId = event.removedId;
				setSnapshots((prev) => {
					if (!prev.has(removedId)) return prev;
					const next = new Map(prev);
					next.delete(removedId);
					return next;
				});
				return;
			}
			const snapshot = event;
			setSnapshots((prev) => {
				const next = new Map(prev);
				next.set(snapshot.id, snapshot);
				return next;
			});
		},
	});

	electronTrpc.serviceStatus.onDefinitionsChange.useSubscription(undefined, {
		onData: (event) => {
			setDefinitions(event.definitions);
		},
	});

	const deleteMutation =
		electronTrpc.serviceStatus.deleteDefinition.useMutation();

	const [dialogTarget, setDialogTarget] =
		useState<ServiceStatusDefinition | null>(null);
	const [dialogOpen, setDialogOpen] = useState(false);
	const [presetDialogOpen, setPresetDialogOpen] = useState(false);
	const [confirmTarget, setConfirmTarget] =
		useState<ServiceStatusDefinition | null>(null);

	const orderedDefinitions = useMemo(
		() =>
			[...definitions].sort(
				(a, b) => a.sortOrder - b.sortOrder || a.label.localeCompare(b.label),
			),
		[definitions],
	);

	// Preset dialog uses apiUrl as the identity key for "already added"
	// detection — it's more stable than label and each Statuspage API URL
	// maps to exactly one provider. URLs are normalized before comparison so
	// trivial variants ("HTTPS://Example.com/" vs "https://example.com",
	// trailing slash, explicit default port) don't let the same service be
	// added twice.
	const existingApiUrls = useMemo(
		() => new Set(definitions.map((d) => normalizeApiUrl(d.apiUrl))),
		[definitions],
	);

	const openCreate = (): void => {
		setDialogTarget(null);
		setDialogOpen(true);
	};

	const openEdit = (def: ServiceStatusDefinition): void => {
		setDialogTarget(def);
		setDialogOpen(true);
	};

	const confirmDelete = async (): Promise<void> => {
		if (!confirmTarget) return;
		try {
			await deleteMutation.mutateAsync({ id: confirmTarget.id });
			toast.success(`${confirmTarget.label} を削除しました`);
			setConfirmTarget(null);
		} catch (error) {
			toast.error(
				`削除に失敗しました: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	};

	return (
		<div className="p-6 max-w-5xl w-full">
			<div className="mb-8 flex items-start justify-between gap-4">
				<div>
					<h2 className="text-xl font-semibold">Service Status</h2>
					<p className="text-sm text-muted-foreground mt-1">
						ヘッダーに表示する外部サービスのステータスインジケーターを管理します。
						主要プロバイダ (Claude / OpenAI / GitHub / Stripe / AWS / GCP /
						Azure …) は<b>プリセットから追加</b>でワンクリック、それ以外は
						<b>手動で追加</b>で任意の URL を登録できます。
					</p>
				</div>
				<div className="flex items-center gap-2">
					<Button
						variant="outline"
						size="sm"
						onClick={() => setPresetDialogOpen(true)}
					>
						<HiOutlineSquares2X2 className="mr-1.5 h-4 w-4" />
						プリセットから追加
					</Button>
					<Button onClick={openCreate} size="sm">
						<HiOutlinePlus className="mr-1.5 h-4 w-4" />
						手動で追加
					</Button>
				</div>
			</div>

			{isItemVisible(
				SETTING_ITEM_ID.SERVICE_STATUS_PROVIDERS,
				visibleItems,
			) && (
				<section className="space-y-3">
					{orderedDefinitions.length === 0 ? (
						<div className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
							まだサービスが登録されていません。右上の「サービスを追加」から追加できます。
						</div>
					) : (
						<div className="rounded-lg border overflow-hidden">
							<Table>
								<TableHeader>
									<TableRow>
										<TableHead className="w-12" />
										<TableHead>ラベル</TableHead>
										<TableHead>ステータス</TableHead>
										<TableHead>API URL</TableHead>
										<TableHead>最終確認</TableHead>
										<TableHead className="text-right w-28">操作</TableHead>
									</TableRow>
								</TableHeader>
								<TableBody>
									{orderedDefinitions.map((def) => {
										const snap = snapshots.get(def.id);
										const level = snap?.level ?? "unknown";
										const dotClass = LEVEL_DOT_CLASS[level];
										return (
											<TableRow key={def.id}>
												<TableCell>
													<div className="flex items-center justify-center size-8 rounded-md bg-accent/30">
														<ServiceStatusIcon
															source={{
																iconType: def.iconType,
																iconValue: def.iconValue,
																statusUrl: def.statusUrl,
																label: def.label,
															}}
															className="size-5"
														/>
													</div>
												</TableCell>
												<TableCell className="font-medium">
													{def.label}
													<div className="text-xs text-muted-foreground truncate max-w-[14rem]">
														{def.statusUrl}
													</div>
												</TableCell>
												<TableCell>
													<span className="inline-flex items-center gap-2">
														<span
															className={cn("size-2.5 rounded-full", dotClass)}
														/>
														<span className="text-sm">
															{LEVEL_LABEL[level]}
														</span>
													</span>
													{snap?.fetchError && (
														<div className="text-xs text-destructive truncate max-w-[14rem]">
															{snap.fetchError}
														</div>
													)}
												</TableCell>
												<TableCell className="text-xs text-muted-foreground truncate max-w-[14rem]">
													{def.apiUrl}
												</TableCell>
												<TableCell className="text-xs text-muted-foreground">
													{formatCheckedAt(snap?.checkedAt ?? 0)}
												</TableCell>
												<TableCell className="text-right">
													<div className="inline-flex items-center gap-1">
														<Button
															variant="ghost"
															size="icon"
															onClick={() => openEdit(def)}
															aria-label={`${def.label} を編集`}
														>
															<HiOutlinePencilSquare className="size-4" />
														</Button>
														<Button
															variant="ghost"
															size="icon"
															onClick={() => setConfirmTarget(def)}
															aria-label={`${def.label} を削除`}
															className="text-destructive hover:text-destructive"
														>
															<HiOutlineTrash className="size-4" />
														</Button>
													</div>
												</TableCell>
											</TableRow>
										);
									})}
								</TableBody>
							</Table>
						</div>
					)}
				</section>
			)}

			<ServiceDefinitionDialog
				open={dialogOpen}
				onOpenChange={(next) => {
					setDialogOpen(next);
					if (!next) setDialogTarget(null);
				}}
				target={dialogTarget}
			/>

			<ServicePresetDialog
				open={presetDialogOpen}
				onOpenChange={setPresetDialogOpen}
				existingApiUrls={existingApiUrls}
			/>

			<AlertDialog
				open={confirmTarget !== null}
				onOpenChange={(next) => {
					if (!next) setConfirmTarget(null);
				}}
			>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>サービスを削除しますか?</AlertDialogTitle>
						<AlertDialogDescription>
							<span className="font-semibold">{confirmTarget?.label}</span>{" "}
							をヘッダーから削除します。この操作は取り消せません。
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel>キャンセル</AlertDialogCancel>
						<AlertDialogAction
							onClick={confirmDelete}
							className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
						>
							削除
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</div>
	);
}
