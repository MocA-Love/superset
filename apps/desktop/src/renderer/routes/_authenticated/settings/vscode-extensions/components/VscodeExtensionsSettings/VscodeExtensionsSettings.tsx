import { Button } from "@superset/ui/button";
import { LuBot, LuExternalLink, LuRefreshCw, LuSparkles } from "react-icons/lu";
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

	if (!showManage) return null;

	return (
		<div className="p-6 max-w-4xl w-full">
			<div className="mb-8">
				<h2 className="text-xl font-semibold">VS Code Extensions</h2>
				<p className="text-sm text-muted-foreground mt-1">
					Manage VS Code extensions running inside Superset Desktop. Extensions
					must be installed in VS Code first.
				</p>
			</div>

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
								marketplaceUrl={ext.marketplaceUrl}
								installed={ext.installed}
								active={ext.active}
								icon={Icon}
								onRestart={() =>
									restartMutation.mutate({ extensionId: ext.id })
								}
								isRestarting={restartMutation.isPending}
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
	marketplaceUrl,
	installed,
	active,
	icon: Icon,
	onRestart,
	isRestarting,
}: {
	id: string;
	name: string;
	publisher: string;
	description: string;
	marketplaceUrl: string;
	installed: boolean;
	active: boolean;
	icon: React.ComponentType<{ className?: string }>;
	onRestart: () => void;
	isRestarting: boolean;
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
					{active && (
						<span className="text-xs bg-green-500/10 text-green-600 dark:text-green-400 px-1.5 py-0.5 rounded">
							Active
						</span>
					)}
					{installed && !active && (
						<span className="text-xs bg-yellow-500/10 text-yellow-600 dark:text-yellow-400 px-1.5 py-0.5 rounded">
							Installed
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
			<div className="flex items-center gap-2 flex-shrink-0">
				{installed && (
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
						variant="outline"
						size="sm"
						onClick={() => window.open(marketplaceUrl, "_blank")}
						className="gap-1.5"
					>
						<LuExternalLink className="size-3.5" />
						Install in VS Code
					</Button>
				)}
			</div>
		</div>
	);
}
