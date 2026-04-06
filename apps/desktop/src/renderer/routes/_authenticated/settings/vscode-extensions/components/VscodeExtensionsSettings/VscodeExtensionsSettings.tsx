import { Button } from "@superset/ui/button";
import { Switch } from "@superset/ui/switch";
import { useState } from "react";
import { LuBot, LuDownload, LuRefreshCw, LuSparkles } from "react-icons/lu";
import { electronTrpc } from "renderer/lib/electron-trpc";
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

export function VscodeExtensionsSettings({
	visibleItems,
}: VscodeExtensionsSettingsProps) {
	const showManage = isItemVisible(
		SETTING_ITEM_ID.VSCODE_EXTENSIONS_MANAGE,
		visibleItems,
	);
	const [pendingRestart, setPendingRestart] = useState(false);

	const { data: extensions, isLoading } =
		electronTrpc.vscodeExtensions.getKnownExtensions.useQuery();
	const utils = electronTrpc.useUtils();
	const restartMutation =
		electronTrpc.vscodeExtensions.restartExtension.useMutation({
			onSuccess: () => {
				utils.vscodeExtensions.getKnownExtensions.invalidate();
				utils.vscodeExtensions.getExtensions.invalidate();
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

	if (!showManage) return null;

	return (
		<div className="p-6 max-w-4xl w-full">
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
