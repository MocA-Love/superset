import { Button } from "@superset/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@superset/ui/dialog";
import { Input } from "@superset/ui/input";
import { toast } from "@superset/ui/sonner";
import { cn } from "@superset/ui/utils";
import { useMemo, useState } from "react";
import {
	HiOutlineCheckCircle,
	HiOutlineMagnifyingGlass,
} from "react-icons/hi2";
import { electronTrpc } from "renderer/lib/electron-trpc";
import { ServiceStatusIcon } from "renderer/lib/service-status/ServiceStatusIcon";
import {
	groupPresetsByCategory,
	PRESET_CATEGORY_LABEL,
	type ServicePreset,
} from "renderer/lib/service-status/service-presets";

export interface ServicePresetDialogProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	/**
	 * URLs already registered in the DB. Used to gray out presets the user
	 * already has so we don't create duplicate rows. Matched on apiUrl (the
	 * stable identity key for a preset).
	 */
	existingApiUrls: ReadonlySet<string>;
}

function matchesQuery(preset: ServicePreset, query: string): boolean {
	if (!query) return true;
	const q = query.trim().toLowerCase();
	if (!q) return true;
	if (preset.label.toLowerCase().includes(q)) return true;
	if (preset.slug.toLowerCase().includes(q)) return true;
	try {
		const host = new URL(preset.statusUrl).host.toLowerCase();
		if (host.includes(q)) return true;
	} catch {
		// statusUrl is validated at preset-definition time, but keep the catch
		// so a malformed entry never crashes the picker.
	}
	return false;
}

export function ServicePresetDialog({
	open,
	onOpenChange,
	existingApiUrls,
}: ServicePresetDialogProps) {
	const [query, setQuery] = useState("");
	const [pendingSlug, setPendingSlug] = useState<string | null>(null);

	const createMutation =
		electronTrpc.serviceStatus.createDefinition.useMutation();

	const groups = useMemo(() => groupPresetsByCategory(), []);
	const filteredGroups = useMemo(() => {
		if (!query.trim()) return groups;
		return groups
			.map((g) => ({
				...g,
				items: g.items.filter((p) => matchesQuery(p, query)),
			}))
			.filter((g) => g.items.length > 0);
	}, [groups, query]);

	const handleAdd = async (preset: ServicePreset): Promise<void> => {
		if (existingApiUrls.has(preset.apiUrl)) return;
		setPendingSlug(preset.slug);
		try {
			await createMutation.mutateAsync({
				label: preset.label,
				statusUrl: preset.statusUrl,
				apiUrl: preset.apiUrl,
				iconType: preset.iconType,
				iconValue: preset.iconValue,
				format: preset.format,
			});
			toast.success(`${preset.label} を追加しました`);
		} catch (error) {
			toast.error(
				`${preset.label} の追加に失敗しました: ${error instanceof Error ? error.message : String(error)}`,
			);
		} finally {
			setPendingSlug(null);
		}
	};

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-2xl max-h-[85vh] overflow-y-auto">
				<DialogHeader>
					<DialogTitle>プリセットから追加</DialogTitle>
					<DialogDescription>
						Statuspage.io 互換 API
						を公開している有名サービスをワンクリックで追加できます。
						ここに無いサービスは「手動で追加」から任意の URL
						を入力してください。
					</DialogDescription>
				</DialogHeader>

				<div className="relative">
					<HiOutlineMagnifyingGlass
						aria-hidden="true"
						className="size-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none"
					/>
					<Input
						value={query}
						onChange={(event) => setQuery(event.target.value)}
						placeholder="サービス名で絞り込み (例: GitHub, Stripe)"
						className="pl-9"
						autoFocus
					/>
				</div>

				<div className="space-y-4">
					{filteredGroups.length === 0 && (
						<p className="text-sm text-muted-foreground text-center py-6">
							該当するサービスが見つかりませんでした
						</p>
					)}
					{filteredGroups.map(({ category, items }) => (
						<section key={category} className="space-y-2">
							<h4 className="text-[10px] font-medium text-muted-foreground/70 uppercase tracking-[0.1em]">
								{PRESET_CATEGORY_LABEL[category]}
							</h4>
							<div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
								{items.map((preset) => {
									const alreadyAdded = existingApiUrls.has(preset.apiUrl);
									const isPending = pendingSlug === preset.slug;
									return (
										<button
											key={preset.slug}
											type="button"
											disabled={alreadyAdded || isPending}
											onClick={() => handleAdd(preset)}
											className={cn(
												"relative flex items-center gap-2 rounded-md border border-border px-3 py-2.5 text-sm text-left transition-colors",
												alreadyAdded
													? "opacity-50 cursor-not-allowed"
													: "hover:bg-accent/40 hover:border-primary/50",
												isPending && "opacity-70 cursor-wait",
											)}
										>
											<ServiceStatusIcon
												source={{
													iconType: preset.iconType,
													iconValue: preset.iconValue,
													statusUrl: preset.statusUrl,
													label: preset.label,
												}}
												className="size-5 shrink-0"
											/>
											<div className="flex-1 min-w-0">
												<div className="truncate font-medium">
													{preset.label}
												</div>
												{alreadyAdded && (
													<div className="text-[10px] text-muted-foreground">
														追加済
													</div>
												)}
											</div>
											{alreadyAdded && (
												<HiOutlineCheckCircle
													aria-hidden="true"
													className="size-4 text-emerald-500 shrink-0"
												/>
											)}
										</button>
									);
								})}
							</div>
						</section>
					))}
				</div>

				<DialogFooter className="mt-2">
					<p className="flex-1 text-xs text-muted-foreground self-center">
						AWS / GCP / Azure 以外は Statuspage.io v2 互換 API
						を利用。接続確認は個別行の 「最終確認」列で確認できます。
					</p>
					<Button
						type="button"
						variant="ghost"
						onClick={() => onOpenChange(false)}
					>
						閉じる
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
