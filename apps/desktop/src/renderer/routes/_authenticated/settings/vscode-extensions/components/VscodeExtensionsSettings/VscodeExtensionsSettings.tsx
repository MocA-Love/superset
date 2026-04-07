import { Button } from "@superset/ui/button";
import { Input } from "@superset/ui/input";
import { Switch } from "@superset/ui/switch";
import { useCallback, useEffect, useRef, useState } from "react";
import {
	LuBot,
	LuDownload,
	LuEraser,
	LuPalette,
	LuPlus,
	LuRefreshCw,
	LuRotateCcw,
	LuSparkles,
	LuTrash2,
} from "react-icons/lu";
import { electronTrpc } from "renderer/lib/electron-trpc";
import { INDENT_RAINBOW_DEFAULT_COLORS } from "renderer/screens/main/components/WorkspaceView/components/CodeEditor/createIndentRainbowPlugin";
import { TRAILING_SPACES_DEFAULT_COLOR } from "renderer/screens/main/components/WorkspaceView/components/CodeEditor/createTrailingSpacesPlugin";
import { toHex, toHex8, withAlpha } from "shared/themes/utils";
import {
	isItemVisible,
	SETTING_ITEM_ID,
	type SettingItemId,
} from "../../../utils/settings-search";

interface VscodeExtensionsSettingsProps {
	visibleItems?: SettingItemId[] | null;
}

const EXTENSION_ICONS: Record<
	string,
	React.ComponentType<{ className?: string }>
> = {
	"anthropic.claude-code": LuBot,
	"openai.chatgpt": LuSparkles,
};

const HEX6_COLOR_RE = /^#[0-9a-f]{6}$/i;
const HEX8_COLOR_RE = /^#[0-9a-f]{8}$/i;
const FALLBACK_PICKER_COLOR = "#808080";

function normalizeColorValue(color: string): string {
	const normalized = toHex8(color.trim());
	return HEX8_COLOR_RE.test(normalized)
		? normalized.toLowerCase()
		: color.trim();
}

function getColorPickerValue(color: string): string {
	const normalized = toHex(color);
	return HEX6_COLOR_RE.test(normalized)
		? normalized.toLowerCase()
		: FALLBACK_PICKER_COLOR;
}

function getColorAlpha(color: string): number {
	const normalized = normalizeColorValue(color);
	if (!HEX8_COLOR_RE.test(normalized)) {
		return 1;
	}

	return Number.parseInt(normalized.slice(7, 9), 16) / 255;
}

function getOpacityPercent(color: string): number {
	return Math.round(getColorAlpha(color) * 100);
}

function normalizeHexInput(value: string): string | null {
	const trimmed = value.trim();
	if (!trimmed) {
		return null;
	}

	const candidate = trimmed.startsWith("#") ? trimmed : `#${trimmed}`;
	const normalized = toHex(candidate);
	return HEX6_COLOR_RE.test(normalized) ? normalized.toLowerCase() : null;
}

function toStoredHex8(hex: string, opacityPercent: number): string {
	const next = normalizeColorValue(withAlpha(hex, opacityPercent / 100));
	return HEX8_COLOR_RE.test(next) ? next : withAlpha(FALLBACK_PICKER_COLOR, 1);
}

function ColorControl({
	value,
	onCommit,
	ariaLabel,
	className,
}: {
	value: string;
	onCommit: (value: string) => void;
	ariaLabel: string;
	className?: string;
}) {
	const [hexDraft, setHexDraft] = useState(() => getColorPickerValue(value));
	const [opacityDraft, setOpacityDraft] = useState(() =>
		getOpacityPercent(value),
	);
	const colorInputRef = useRef<HTMLInputElement>(null);

	useEffect(() => {
		setHexDraft(getColorPickerValue(value));
		setOpacityDraft(getOpacityPercent(value));
	}, [value]);

	const commitHexDraft = useCallback(() => {
		const normalizedHex = normalizeHexInput(hexDraft);
		if (!normalizedHex) {
			setHexDraft(getColorPickerValue(value));
			return;
		}

		setHexDraft(normalizedHex);
		const next = toStoredHex8(normalizedHex, opacityDraft);
		if (next !== value) {
			onCommit(next);
		}
	}, [hexDraft, onCommit, opacityDraft, value]);

	const handlePickerChange = useCallback(
		(event: React.ChangeEvent<HTMLInputElement>) => {
			const nextHex = event.target.value.toLowerCase();
			setHexDraft(nextHex);
			const next = toStoredHex8(nextHex, opacityDraft);
			if (next !== value) {
				onCommit(next);
			}
		},
		[onCommit, opacityDraft, value],
	);

	const handleOpacityChange = useCallback(
		(event: React.ChangeEvent<HTMLInputElement>) => {
			const nextOpacity = Number(event.target.value);
			setOpacityDraft(nextOpacity);
			const nextHex = normalizeHexInput(hexDraft) ?? getColorPickerValue(value);
			const next = toStoredHex8(nextHex, nextOpacity);
			if (next !== value) {
				onCommit(next);
			}
		},
		[hexDraft, onCommit, value],
	);

	return (
		<div className="flex items-center gap-2 flex-1 min-w-0">
			<button
				type="button"
				onClick={() => colorInputRef.current?.click()}
				className="size-6 rounded border flex-shrink-0 cursor-pointer transition-transform hover:scale-105 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
				style={{ backgroundColor: value }}
				aria-label={ariaLabel}
			/>
			<input
				ref={colorInputRef}
				type="color"
				value={normalizeHexInput(hexDraft) ?? getColorPickerValue(value)}
				onChange={handlePickerChange}
				className="sr-only"
				tabIndex={-1}
				aria-hidden="true"
			/>
			<Input
				value={hexDraft}
				onChange={(event) => setHexDraft(event.target.value)}
				onBlur={commitHexDraft}
				onKeyDown={(event) => {
					if (event.key === "Enter") {
						event.currentTarget.blur();
					}
					if (event.key === "Escape") {
						setHexDraft(getColorPickerValue(value));
						event.currentTarget.blur();
					}
				}}
				className={className}
				spellCheck={false}
				autoCapitalize="off"
				autoCorrect="off"
			/>
			<div className="flex items-center gap-2 min-w-0 w-40">
				<input
					type="range"
					min="0"
					max="100"
					value={opacityDraft}
					onChange={handleOpacityChange}
					className="h-7 flex-1 accent-primary"
					aria-label={`${ariaLabel} opacity`}
				/>
				<span className="w-10 text-right text-xs text-muted-foreground tabular-nums">
					{opacityDraft}%
				</span>
			</div>
		</div>
	);
}

export function VscodeExtensionsSettings({
	visibleItems,
}: VscodeExtensionsSettingsProps) {
	const showManage = isItemVisible(
		SETTING_ITEM_ID.VSCODE_EXTENSIONS_MANAGE,
		visibleItems,
	);
	const [pendingRestart, setPendingRestart] = useState(false);
	const [useSupersetTheme, setUseSupersetTheme] = useState(
		() => localStorage.getItem("vscode-use-superset-theme") === "true",
	);

	const { data: extensions, isLoading } =
		electronTrpc.vscodeExtensions.getKnownExtensions.useQuery();
	const utils = electronTrpc.useUtils();
	const restartMutation =
		electronTrpc.vscodeExtensions.restartExtension.useMutation({
			onSuccess: () => {
				utils.vscodeExtensions.getKnownExtensions.invalidate();
			},
		});
	const installMutation =
		electronTrpc.vscodeExtensions.installExtension.useMutation({
			onSuccess: () => {
				utils.vscodeExtensions.getKnownExtensions.invalidate();
			},
		});
	const enabledMutation =
		electronTrpc.vscodeExtensions.setExtensionEnabled.useMutation({
			onSuccess: () => {
				utils.vscodeExtensions.getKnownExtensions.invalidate();
				setPendingRestart(true);
			},
		});

	const showIndentRainbow = isItemVisible(
		SETTING_ITEM_ID.VSCODE_EXTENSIONS_INDENT_RAINBOW,
		visibleItems,
	);
	const showTrailingSpaces = isItemVisible(
		SETTING_ITEM_ID.VSCODE_EXTENSIONS_TRAILING_SPACES,
		visibleItems,
	);

	const showEditorFeatures = showIndentRainbow || showTrailingSpaces;

	if (!showManage && !showEditorFeatures) return null;

	return (
		<div className="p-6 max-w-4xl w-full">
			{showManage && (
				<>
					<div className="mb-8">
						<h2 className="text-xl font-semibold">VS Code Extensions</h2>
						<p className="text-sm text-muted-foreground mt-1">
							Manage VS Code extensions running inside Superset Desktop.
						</p>
					</div>

					{pendingRestart && (
						<div className="mb-4 p-3 border rounded-lg bg-yellow-500/5 border-yellow-500/20 flex items-center justify-between">
							<p className="text-sm text-yellow-600 dark:text-yellow-400">
								Changes require app restart to take full effect.
							</p>
							<Button
								variant="outline"
								size="sm"
								onClick={() => {
									try {
										const { BrowserWindow } = window.require("electron");
										BrowserWindow.getFocusedWindow()?.reload();
									} catch {
										window.location.reload();
									}
								}}
								className="gap-1.5"
							>
								<LuRefreshCw className="size-3.5" />
								Restart Now
							</Button>
						</div>
					)}

					{isLoading ? (
						<p className="text-sm text-muted-foreground">Loading...</p>
					) : (
						<div className="space-y-4">
							{extensions?.map((ext) => {
								const Icon = EXTENSION_ICONS[ext.id] ?? LuBot;
								return (
									<ExtensionCard
										key={ext.id}
										id={ext.id}
										name={ext.name}
										publisher={ext.publisher}
										description={ext.description}
										installed={ext.installed}
										enabled={ext.enabled}
										active={ext.active}
										icon={Icon}
										onToggleEnabled={(enabled) =>
											enabledMutation.mutate({
												extensionId: ext.id,
												enabled,
											})
										}
										onRestart={() =>
											restartMutation.mutate({ extensionId: ext.id })
										}
										isRestarting={restartMutation.isPending}
										onInstall={() =>
											installMutation.mutate({ extensionId: ext.id })
										}
										isInstalling={installMutation.isPending}
									/>
								);
							})}
						</div>
					)}
					<div className="mt-6 p-4 border rounded-lg">
						<div className="flex items-center justify-between">
							<div className="flex items-center gap-3">
								<LuPalette className="size-5 text-muted-foreground" />
								<div>
									<h3 className="font-medium text-sm">Use Superset Theme</h3>
									<p className="text-xs text-muted-foreground mt-0.5">
										Apply Superset&apos;s color theme to extension webviews
									</p>
								</div>
							</div>
							<Switch
								checked={useSupersetTheme}
								onCheckedChange={(checked) => {
									setUseSupersetTheme(checked);
									localStorage.setItem(
										"vscode-use-superset-theme",
										String(checked),
									);
								}}
							/>
						</div>
					</div>
				</>
			)}

			{showEditorFeatures && (
				<div className="mt-10">
					<div className="mb-6">
						<h2 className="text-xl font-semibold">Editor Features</h2>
						<p className="text-sm text-muted-foreground mt-1">
							Built-in editor enhancements for Superset Desktop.
						</p>
					</div>
					<div className="space-y-4">
						{showIndentRainbow && <IndentRainbowSettings />}
						{showTrailingSpaces && <TrailingSpacesSettings />}
					</div>
				</div>
			)}
		</div>
	);
}

function ExtensionCard({
	id,
	name,
	publisher,
	description,
	installed,
	enabled,
	active,
	icon: Icon,
	onToggleEnabled,
	onRestart,
	isRestarting,
	onInstall,
	isInstalling,
}: {
	id: string;
	name: string;
	publisher: string;
	description: string;
	installed: boolean;
	enabled: boolean;
	active: boolean;
	icon: React.ComponentType<{ className?: string }>;
	onToggleEnabled: (enabled: boolean) => void;
	onRestart: () => void;
	isRestarting: boolean;
	onInstall: () => void;
	isInstalling: boolean;
}) {
	return (
		<div className="flex items-start gap-4 p-4 border rounded-lg">
			<div className="flex-shrink-0 mt-0.5">
				<div className="w-10 h-10 rounded-lg bg-muted flex items-center justify-center">
					<Icon className="size-5 text-muted-foreground" />
				</div>
			</div>
			<div className="flex-1 min-w-0">
				<div className="flex items-center gap-2">
					<h3 className="font-medium text-sm">{name}</h3>
					<span className="text-xs text-muted-foreground">{publisher}</span>
					{active && enabled && (
						<span className="text-xs bg-green-500/10 text-green-600 dark:text-green-400 px-1.5 py-0.5 rounded">
							Active
						</span>
					)}
					{installed && !active && enabled && (
						<span className="text-xs bg-yellow-500/10 text-yellow-600 dark:text-yellow-400 px-1.5 py-0.5 rounded">
							Installed
						</span>
					)}
					{installed && !enabled && (
						<span className="text-xs bg-muted text-muted-foreground px-1.5 py-0.5 rounded">
							Disabled
						</span>
					)}
					{!installed && (
						<span className="text-xs bg-muted text-muted-foreground px-1.5 py-0.5 rounded">
							Not Installed
						</span>
					)}
				</div>
				<p className="text-xs text-muted-foreground mt-1">{description}</p>
				<p className="text-xs text-muted-foreground mt-0.5 font-mono">{id}</p>
			</div>
			<div className="flex items-center gap-3 flex-shrink-0">
				{installed && (
					<div className="flex items-center gap-2">
						<Switch
							checked={enabled}
							onCheckedChange={onToggleEnabled}
							aria-label={`${enabled ? "Disable" : "Enable"} ${name}`}
						/>
					</div>
				)}
				{installed && enabled && (
					<Button
						variant="outline"
						size="sm"
						onClick={onRestart}
						disabled={isRestarting}
						className="gap-1.5"
					>
						<LuRefreshCw
							className={`size-3.5 ${isRestarting ? "animate-spin" : ""}`}
						/>
						Restart
					</Button>
				)}
				{!installed && (
					<Button
						variant="default"
						size="sm"
						onClick={onInstall}
						disabled={isInstalling}
						className="gap-1.5"
					>
						{isInstalling ? (
							<>
								<LuRefreshCw className="size-3.5 animate-spin" />
								Installing...
							</>
						) : (
							<>
								<LuDownload className="size-3.5" />
								Install
							</>
						)}
					</Button>
				)}
			</div>
		</div>
	);
}

function IndentRainbowSettings() {
	const { data } = electronTrpc.settings.getIndentRainbow.useQuery(undefined, {
		staleTime: 30_000,
	});
	const utils = electronTrpc.useUtils();
	const mutation = electronTrpc.settings.setIndentRainbow.useMutation({
		onSuccess: () => {
			utils.settings.getIndentRainbow.invalidate();
		},
	});

	const enabled = data?.enabled ?? false;
	const colors = (data?.colors ?? INDENT_RAINBOW_DEFAULT_COLORS).map(
		normalizeColorValue,
	);

	const handleToggle = useCallback(
		(checked: boolean) => {
			mutation.mutate({ enabled: checked });
		},
		[mutation],
	);

	const handleColorChange = useCallback(
		(index: number, value: string) => {
			const next = [...colors];
			next[index] = value;
			mutation.mutate({ colors: next });
		},
		[colors, mutation],
	);

	const handleRemoveColor = useCallback(
		(index: number) => {
			const next = colors.filter((_, i) => i !== index);
			mutation.mutate({ colors: next.length > 0 ? next : null });
		},
		[colors, mutation],
	);

	const handleAddColor = useCallback(() => {
		const next = [...colors, "#80808026"];
		mutation.mutate({ colors: next });
	}, [colors, mutation]);

	const handleResetColors = useCallback(() => {
		mutation.mutate({ colors: null });
	}, [mutation]);

	return (
		<div className="border rounded-lg p-4">
			<div className="flex items-start gap-4">
				<div className="flex-shrink-0 mt-0.5">
					<div className="w-10 h-10 rounded-lg bg-muted flex items-center justify-center">
						<LuPalette className="size-5 text-muted-foreground" />
					</div>
				</div>
				<div className="flex-1 min-w-0">
					<div className="flex items-center gap-2">
						<h3 className="font-medium text-sm">Indent Rainbow</h3>
						{enabled && (
							<span className="text-xs bg-green-500/10 text-green-600 dark:text-green-400 px-1.5 py-0.5 rounded">
								Active
							</span>
						)}
					</div>
					<p className="text-xs text-muted-foreground mt-1">
						Colorize indentation levels in the code editor with rainbow colors.
					</p>
				</div>
				<div className="flex-shrink-0">
					<Switch
						checked={enabled}
						onCheckedChange={handleToggle}
						aria-label="Toggle Indent Rainbow"
					/>
				</div>
			</div>

			{enabled && (
				<div className="mt-4 pt-4 border-t">
					<div className="flex items-center justify-between mb-3">
						<p className="text-sm font-medium">Colors</p>
						<div className="flex items-center gap-2">
							<Button
								variant="ghost"
								size="sm"
								onClick={handleResetColors}
								className="gap-1.5 h-7 text-xs"
							>
								<LuRotateCcw className="size-3" />
								Reset
							</Button>
							<Button
								variant="ghost"
								size="sm"
								onClick={handleAddColor}
								className="gap-1.5 h-7 text-xs"
							>
								<LuPlus className="size-3" />
								Add
							</Button>
						</div>
					</div>
					<div className="space-y-2">
						{colors.map((color, index) => {
							const duplicateCount = colors
								.slice(0, index + 1)
								.filter((entry) => entry === color).length;

							return (
								<div
									key={`${color}-${duplicateCount}`}
									className="flex items-center gap-2"
								>
									<span className="text-xs text-muted-foreground w-5 flex-shrink-0 tabular-nums">
										{index + 1}
									</span>
									<ColorControl
										value={color}
										onCommit={(value) => handleColorChange(index, value)}
										ariaLabel={`Pick indent rainbow color ${index + 1}`}
										className="h-7 text-xs font-mono w-32"
									/>
									<Button
										variant="ghost"
										size="sm"
										onClick={() => handleRemoveColor(index)}
										className="h-7 w-7 p-0 flex-shrink-0"
										disabled={colors.length <= 1}
									>
										<LuTrash2 className="size-3 text-muted-foreground" />
									</Button>
								</div>
							);
						})}
					</div>
				</div>
			)}
		</div>
	);
}

function TrailingSpacesSettings() {
	const { data } = electronTrpc.settings.getTrailingSpaces.useQuery(undefined, {
		staleTime: 30_000,
	});
	const utils = electronTrpc.useUtils();
	const mutation = electronTrpc.settings.setTrailingSpaces.useMutation({
		onSuccess: () => {
			utils.settings.getTrailingSpaces.invalidate();
		},
	});

	const enabled = data?.enabled ?? false;
	const color = normalizeColorValue(
		data?.color ?? TRAILING_SPACES_DEFAULT_COLOR,
	);

	const handleToggle = useCallback(
		(checked: boolean) => {
			mutation.mutate({ enabled: checked });
		},
		[mutation],
	);

	const handleColorChange = useCallback(
		(value: string) => {
			mutation.mutate({ color: value });
		},
		[mutation],
	);

	const handleResetColor = useCallback(() => {
		mutation.mutate({ color: null });
	}, [mutation]);

	return (
		<div className="border rounded-lg p-4">
			<div className="flex items-start gap-4">
				<div className="flex-shrink-0 mt-0.5">
					<div className="w-10 h-10 rounded-lg bg-muted flex items-center justify-center">
						<LuEraser className="size-5 text-muted-foreground" />
					</div>
				</div>
				<div className="flex-1 min-w-0">
					<div className="flex items-center gap-2">
						<h3 className="font-medium text-sm">Trailing Spaces</h3>
						{enabled && (
							<span className="text-xs bg-green-500/10 text-green-600 dark:text-green-400 px-1.5 py-0.5 rounded">
								Active
							</span>
						)}
					</div>
					<p className="text-xs text-muted-foreground mt-1">
						Highlight trailing whitespace at the end of lines. The current
						cursor line is excluded.
					</p>
				</div>
				<div className="flex-shrink-0">
					<Switch
						checked={enabled}
						onCheckedChange={handleToggle}
						aria-label="Toggle Trailing Spaces"
					/>
				</div>
			</div>

			{enabled && (
				<div className="mt-4 pt-4 border-t">
					<div className="flex items-center gap-3">
						<p className="text-sm font-medium">Highlight Color</p>
						<div className="flex items-center gap-2 flex-1">
							<ColorControl
								value={color}
								onCommit={handleColorChange}
								ariaLabel="Pick trailing spaces highlight color"
								className="h-7 text-xs font-mono w-32"
							/>
							<Button
								variant="ghost"
								size="sm"
								onClick={handleResetColor}
								className="gap-1.5 h-7 text-xs flex-shrink-0"
							>
								<LuRotateCcw className="size-3" />
								Reset
							</Button>
						</div>
					</div>
				</div>
			)}
		</div>
	);
}
