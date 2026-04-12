import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
	EnterEnabledAlertDialogContent,
} from "@superset/ui/alert-dialog";
import { Button } from "@superset/ui/button";
import { useEffect, useState } from "react";

export interface CreatePullRequestBaseRepoOption {
	label: string;
	repoNameWithOwner: string;
	repoUrl: string;
	source: "current" | "tracking" | "upstream";
}

interface CreatePullRequestBaseRepoDialogProps {
	open: boolean;
	options: CreatePullRequestBaseRepoOption[];
	isPending?: boolean;
	title?: string;
	description?: string;
	confirmLabel?: string;
	onOpenChange: (open: boolean) => void;
	onConfirm: (repoUrl: string) => void;
}

function getSourceDescription(
	source: CreatePullRequestBaseRepoOption["source"],
): string {
	switch (source) {
		case "tracking":
			return "現在のブランチの追跡先リモート";
		case "upstream":
			return "Upstream リポジトリ";
		default:
			return "このリポジトリ";
	}
}

export function CreatePullRequestBaseRepoDialog({
	open,
	options,
	isPending = false,
	title = "Pull Request の base リポジトリを選択",
	description = "このブランチは複数の GitHub リポジトリに対して Pull Request を作成できます。どこに向けて PR を作るか選んでください。選択はこのブランチに記憶されます。",
	confirmLabel = "続行",
	onOpenChange,
	onConfirm,
}: CreatePullRequestBaseRepoDialogProps) {
	const [selectedRepoUrl, setSelectedRepoUrl] = useState<string | null>(null);

	useEffect(() => {
		if (!open) {
			setSelectedRepoUrl(null);
		}
	}, [open]);

	return (
		<AlertDialog open={open} onOpenChange={onOpenChange}>
			<EnterEnabledAlertDialogContent className="max-w-[420px] gap-0 p-0">
				<AlertDialogHeader className="px-4 pt-4 pb-2">
					<AlertDialogTitle className="font-medium">{title}</AlertDialogTitle>
					<AlertDialogDescription>{description}</AlertDialogDescription>
				</AlertDialogHeader>
				<div className="flex flex-col gap-2 px-4 pb-2">
					{options.map((option) => {
						const isSelected = option.repoUrl === selectedRepoUrl;
						return (
							<button
								key={option.repoUrl}
								type="button"
								className={`flex flex-col rounded-md border px-3 py-2 text-left transition-colors ${
									isSelected
										? "border-foreground/30 bg-accent"
										: "border-border hover:bg-accent/60"
								}`}
								onClick={() => setSelectedRepoUrl(option.repoUrl)}
							>
								<span className="text-sm font-medium">
									{option.repoNameWithOwner}
								</span>
								<span className="text-xs text-muted-foreground">
									{getSourceDescription(option.source)}
								</span>
							</button>
						);
					})}
				</div>
				<AlertDialogFooter className="flex-row justify-end gap-2 px-4 pb-4 pt-2">
					<Button
						variant="ghost"
						size="sm"
						className="h-7 px-3 text-xs"
						onClick={() => onOpenChange(false)}
					>
						キャンセル
					</Button>
					<AlertDialogAction
						size="sm"
						className="h-7 px-3 text-xs"
						disabled={!selectedRepoUrl || isPending}
						onClick={() => {
							if (!selectedRepoUrl) {
								return;
							}
							onConfirm(selectedRepoUrl);
						}}
					>
						{confirmLabel}
					</AlertDialogAction>
				</AlertDialogFooter>
			</EnterEnabledAlertDialogContent>
		</AlertDialog>
	);
}
