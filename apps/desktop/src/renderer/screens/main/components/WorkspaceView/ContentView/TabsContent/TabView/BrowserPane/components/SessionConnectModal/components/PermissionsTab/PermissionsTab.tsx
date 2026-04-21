import { Button } from "@superset/ui/button";
import { Input } from "@superset/ui/input";
import { Label } from "@superset/ui/label";
import { toast } from "@superset/ui/sonner";
import { Switch } from "@superset/ui/switch";
import { cn } from "@superset/ui/utils";
import { useEffect, useMemo, useState } from "react";
import { LuCheck, LuCopy, LuPlus, LuTrash2 } from "react-icons/lu";
import { electronTrpc } from "renderer/lib/electron-trpc";

type PermissionToggleKey =
	| "cookieRead"
	| "cookieWrite"
	| "storageWrite"
	| "permissions"
	| "privilegedSchemes"
	| "downloadOverride"
	| "uaOverride"
	| "debugger"
	| "networkIntercept";

type PermissionToggles = Partial<Record<PermissionToggleKey, boolean>>;

interface PermissionPreset {
	id: string;
	name: string;
	builtin?: boolean;
	toggles: PermissionToggles;
}

export function PermissionsTab() {
	const configQuery = electronTrpc.browserPermissions.getConfig.useQuery();
	const metaQuery = electronTrpc.browserPermissions.getToggleMeta.useQuery();
	const setActive = electronTrpc.browserPermissions.setActive.useMutation();
	const savePreset = electronTrpc.browserPermissions.savePreset.useMutation();
	const deletePreset =
		electronTrpc.browserPermissions.deletePreset.useMutation();
	const utils = electronTrpc.useUtils();

	const config = configQuery.data;
	const meta = metaQuery.data;

	const [selectedId, setSelectedId] = useState<string | null>(null);
	const selected = useMemo<PermissionPreset | null>(() => {
		if (!config) return null;
		const id = selectedId ?? config.activePresetId;
		return config.presets.find((p) => p.id === id) ?? null;
	}, [config, selectedId]);

	// Local editing buffer so toggles feel snappy and so renaming
	// doesn't commit on every keystroke.
	const [draftName, setDraftName] = useState("");
	const [draftToggles, setDraftToggles] = useState<PermissionToggles>({});
	const [dirty, setDirty] = useState(false);

	useEffect(() => {
		if (!selected) return;
		setDraftName(selected.name);
		setDraftToggles({ ...selected.toggles });
		setDirty(false);
	}, [selected]);

	if (!config || !meta) {
		return (
			<div className="p-4 text-xs text-muted-foreground">
				Loading permissions…
			</div>
		);
	}

	const toggleKeys = Object.keys(meta) as PermissionToggleKey[];

	const isActive = selected?.id === config.activePresetId;
	const isBuiltin = selected?.builtin === true;

	const handleToggle = (key: PermissionToggleKey, value: boolean) => {
		setDraftToggles((prev) => ({ ...prev, [key]: value }));
		setDirty(true);
	};

	const handleSave = async () => {
		if (!selected) return;
		if (isBuiltin) {
			toast.error("Built-in presets can't be edited. Duplicate first.");
			return;
		}
		try {
			await savePreset.mutateAsync({
				id: selected.id,
				name: draftName.trim() || selected.name,
				toggles: draftToggles,
			});
			await utils.browserPermissions.getConfig.invalidate();
			toast.success("Preset saved");
			setDirty(false);
		} catch (error) {
			toast.error(
				`Save failed: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	};

	const handleDuplicate = async () => {
		if (!selected) return;
		try {
			const suggested = `${selected.name} (copy)`;
			const newPreset = await savePreset.mutateAsync({
				name: suggested,
				toggles: draftToggles,
			});
			await utils.browserPermissions.getConfig.invalidate();
			setSelectedId(newPreset.id);
			toast.success(`Duplicated as "${newPreset.name}"`);
		} catch (error) {
			toast.error(
				`Duplicate failed: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	};

	const handleCreate = async () => {
		try {
			const newPreset = await savePreset.mutateAsync({
				name: "Untitled preset",
				toggles: {},
			});
			await utils.browserPermissions.getConfig.invalidate();
			setSelectedId(newPreset.id);
			toast.success("Preset created");
		} catch (error) {
			toast.error(
				`Create failed: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	};

	const handleDelete = async () => {
		if (!selected || isBuiltin) return;
		try {
			await deletePreset.mutateAsync({ id: selected.id });
			await utils.browserPermissions.getConfig.invalidate();
			setSelectedId(null);
			toast.info(`Deleted preset "${selected.name}"`);
		} catch (error) {
			toast.error(
				`Delete failed: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	};

	const handleSetActive = async () => {
		if (!selected) return;
		if (dirty) {
			toast.error("Save pending changes before activating.");
			return;
		}
		try {
			await setActive.mutateAsync({ presetId: selected.id });
			await utils.browserPermissions.getConfig.invalidate();
			toast.success(`"${selected.name}" is now active`);
		} catch (error) {
			toast.error(
				`Activate failed: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	};

	return (
		<div className="grid grid-cols-[240px_1fr] h-full min-h-0">
			<div className="overflow-y-auto p-3 border-r">
				<div className="flex items-center justify-between mb-2">
					<div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70">
						Presets
					</div>
					<button
						type="button"
						onClick={handleCreate}
						className="inline-flex items-center gap-1 rounded-md border bg-background/60 px-2 py-1 text-[11px] text-muted-foreground hover:text-foreground"
						title="New preset"
					>
						<LuPlus className="size-3" />
						New
					</button>
				</div>
				<div className="flex flex-col gap-1.5">
					{config.presets.map((p) => {
						const selectedHere = p.id === selected?.id;
						const active = p.id === config.activePresetId;
						return (
							<button
								key={p.id}
								type="button"
								onClick={() => setSelectedId(p.id)}
								className={cn(
									"text-left rounded-md border p-2 transition-colors",
									selectedHere
										? "border-brand/40 bg-brand/10"
										: "border-border bg-card hover:bg-muted/40",
								)}
							>
								<div className="flex items-center justify-between gap-2">
									<span className="text-[13px] font-medium truncate">
										{p.name}
									</span>
									{active && (
										<span className="shrink-0 inline-flex items-center gap-0.5 rounded-full bg-emerald-500/15 text-emerald-300 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider">
											<LuCheck className="size-2.5" />
											Active
										</span>
									)}
								</div>
								<div className="mt-0.5 text-[10px] text-muted-foreground">
									{p.builtin ? "Built-in" : "Custom"}
								</div>
							</button>
						);
					})}
				</div>
			</div>

			<div className="flex flex-col min-h-0">
				{!selected ? (
					<div className="p-4 text-xs text-muted-foreground">
						Select a preset on the left.
					</div>
				) : (
					<>
						{/* Sticky header: name input + duplicate/delete stay visible. */}
						<div className="shrink-0 p-4 pb-3 border-b bg-background">
							<div className="flex items-end gap-2">
								<div className="flex-1">
									<Label className="text-[11px] text-muted-foreground">
										Preset name
									</Label>
									<Input
										value={draftName}
										disabled={isBuiltin}
										onChange={(e) => {
											setDraftName(e.target.value);
											setDirty(true);
										}}
										className="mt-1 h-8 text-[13px]"
									/>
								</div>
								<Button
									type="button"
									variant="outline"
									size="sm"
									onClick={handleDuplicate}
									disabled={savePreset.isPending}
								>
									<LuCopy className="size-3.5 mr-1" />
									Duplicate
								</Button>
								{!isBuiltin && (
									<Button
										type="button"
										variant="outline"
										size="sm"
										onClick={handleDelete}
										disabled={deletePreset.isPending || isActive}
										title={
											isActive
												? "Activate a different preset first to delete this one"
												: undefined
										}
									>
										<LuTrash2 className="size-3.5 mr-1" />
										Delete
									</Button>
								)}
							</div>
							{isBuiltin && (
								<div className="mt-3 rounded-md border border-amber-500/30 bg-amber-500/10 p-2 text-[11px] text-amber-200">
									Built-in preset. Duplicate to customize.
								</div>
							)}
						</div>

						{/* Scrollable toggle list — only this region scrolls so the
						    header and the Save/Activate action bar stay on screen
						    even with many toggle rows. */}
						<div className="flex-1 min-h-0 overflow-y-auto p-4">
							<div className="flex flex-col divide-y border rounded-md">
								{toggleKeys.map((key) => {
									const m = meta[key];
									const value = draftToggles[key] === true;
									return (
										<div key={key} className="flex items-start gap-3 p-3">
											<div className="flex-1 min-w-0">
												<div className="text-[12px] font-medium">{m.label}</div>
												<div className="mt-0.5 text-[11px] text-muted-foreground leading-snug">
													{m.description}
												</div>
												<div className="mt-1 text-[10px] font-mono text-muted-foreground/70 truncate">
													{m.methods.join(", ")}
												</div>
											</div>
											<Switch
												checked={value}
												disabled={isBuiltin}
												onCheckedChange={(v: boolean) => handleToggle(key, v)}
											/>
										</div>
									);
								})}
							</div>
						</div>

						{/* Sticky action bar. */}
						<div className="shrink-0 flex items-center justify-between gap-3 px-4 py-3 border-t bg-background">
							<div className="text-[11px] text-muted-foreground min-w-0 flex-1 line-clamp-2">
								{isActive
									? "Active preset. Changes apply to all live MCP sessions after save."
									: "Save, then click Activate to apply to MCP sessions."}
							</div>
							<div className="flex items-center gap-2 shrink-0">
								{!isBuiltin && (
									<Button
										type="button"
										size="sm"
										variant="outline"
										disabled={!dirty || savePreset.isPending}
										onClick={handleSave}
									>
										Save
									</Button>
								)}
								<Button
									type="button"
									size="sm"
									disabled={isActive || setActive.isPending}
									onClick={handleSetActive}
								>
									{isActive ? "Active" : "Activate"}
								</Button>
							</div>
						</div>
					</>
				)}
			</div>
		</div>
	);
}
