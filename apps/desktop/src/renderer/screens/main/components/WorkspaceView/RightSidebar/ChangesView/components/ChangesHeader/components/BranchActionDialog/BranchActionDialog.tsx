import {
	AlertDialog as BranchAlertDialog,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
	EnterEnabledAlertDialogContent,
} from "@superset/ui/alert-dialog";
import { Button } from "@superset/ui/button";
import type { ReactNode } from "react";
import { HiExclamationTriangle } from "react-icons/hi2";
import { LuGitBranch, LuLock, LuRefreshCcw, LuShieldAlert } from "react-icons/lu";

export type BranchProgressOperation =
	| "merge"
	| "rebase"
	| "cherry-pick"
	| "revert"
	| "bisect";

type BranchActionTarget =
	| {
			action: "switch";
			branch: string;
	  }
	| {
			action: "create-from-ref";
			branch: string;
			startPointRef: string;
			startPointDisplayName: string | null;
	  };

export interface BranchActionDialogState {
	kind:
		| "dirty-uncommitted"
		| "dirty-untracked"
		| "conflicted"
		| "operation-in-progress"
		| "checked-out-elsewhere"
		| "reference-missing"
		| "git-busy"
		| "stash-failed"
		| "compare-detached-head";
	target?: BranchActionTarget;
	checkedOutPath?: string | null;
	message?: string | null;
	operation?: BranchProgressOperation | null;
}

interface BranchActionDialogProps {
	open: boolean;
	state: BranchActionDialogState | null;
	isPending?: boolean;
	onOpenChange: (open: boolean) => void;
	onContinueWithoutStash?: () => void;
	onStashTrackedAndContinue?: () => void;
	onStashAllAndContinue?: () => void;
}

interface DialogCopy {
	title: string;
	description: string;
	icon: ReactNode;
	primaryLabel?: string;
	secondaryLabel?: string;
}

function getActionLabel(target?: BranchActionTarget): string {
	if (!target) {
		return "この操作";
	}

	if (target.action === "switch") {
		return `「${target.branch}」へ切り替える操作`;
	}

	if (target.startPointDisplayName) {
		return `「${target.startPointDisplayName}」から「${target.branch}」を作る操作`;
	}

	return `「${target.branch}」を作る操作`;
}

function getOperationLabel(operation?: BranchProgressOperation | null): string {
	switch (operation) {
		case "merge":
			return "merge";
		case "rebase":
			return "rebase";
		case "cherry-pick":
			return "cherry-pick";
		case "revert":
			return "revert";
		case "bisect":
			return "bisect";
		default:
			return "Git";
	}
}

function getDialogCopy(state: BranchActionDialogState | null): DialogCopy {
	if (!state) {
		return {
			title: "",
			description: "",
			icon: null,
		};
	}

	const actionLabel = getActionLabel(state.target);

	switch (state.kind) {
		case "dirty-untracked":
			return {
				title: "未追跡ファイルがあります",
				description: `${actionLabel}の前に、新規ファイルを退避する必要があります。未追跡ファイルも含めて stash するか、そのまま続けて Git の判定に任せてください。`,
				icon: <LuGitBranch className="size-4" />,
				primaryLabel:
					state.target?.action === "create-from-ref"
						? "stash して作成"
						: "stash して切り替える",
				secondaryLabel:
					state.target?.action === "create-from-ref"
						? "そのまま作成する"
						: "そのまま切り替える",
			};
		case "dirty-uncommitted":
			return {
				title: "未コミットの変更があります",
				description: `${actionLabel}の前に、いまの変更を退避できます。変更を残したい場合は stash してから続けてください。`,
				icon: <LuGitBranch className="size-4" />,
				primaryLabel:
					state.target?.action === "create-from-ref"
						? "stash して作成"
						: "stash して切り替える",
				secondaryLabel:
					state.target?.action === "create-from-ref"
						? "そのまま作成する"
						: "そのまま切り替える",
			};
		case "conflicted":
			return {
				title: "競合を解決してからやり直してください",
				description:
					"この workspace には未解決の conflict があります。先に競合を解決しないと、branch の切り替えや別 ref からの作成は安全に進められません。",
				icon: <HiExclamationTriangle className="size-4" />,
			};
		case "operation-in-progress":
			return {
				title: `${getOperationLabel(state.operation)} を完了してからやり直してください`,
				description:
					"別の Git 操作が途中です。先にその操作を完了または中止してから、もう一度 branch 操作を行ってください。",
				icon: <LuRefreshCcw className="size-4" />,
			};
		case "checked-out-elsewhere":
			return {
				title: "このブランチは別の workspace で開かれています",
				description: state.checkedOutPath
					? `「${state.target?.action === "switch" ? state.target.branch : ""}」は別の workspace で checkout 済みです。\n${state.checkedOutPath}`
					: "同じブランチは複数の worktree で同時に checkout できません。",
				icon: <LuLock className="size-4" />,
			};
		case "reference-missing":
			return {
				title: "選んだ参照が見つかりません",
				description:
					"ブランチ一覧を開いてからの間に、対象の branch や ref が削除された可能性があります。一覧を開き直して、最新の状態から選び直してください。",
				icon: <HiExclamationTriangle className="size-4" />,
			};
		case "git-busy":
			return {
				title: "別の Git 操作が進行中です",
				description:
					state.message ??
					"repository が一時的にロックされています。少し待ってから再試行してください。",
				icon: <LuLock className="size-4" />,
			};
		case "stash-failed":
			return {
				title: "変更の退避に失敗しました",
				description:
					state.message ??
					"stash に失敗したため、このまま branch 操作を続けられません。手動で変更を整理してからやり直してください。",
				icon: <HiExclamationTriangle className="size-4" />,
			};
		case "compare-detached-head":
			return {
				title: "compare branch は変更できません",
				description:
					"現在は detached HEAD のため、どの branch の設定として保存するか決められません。先に branch を checkout してから変更してください。",
				icon: <LuShieldAlert className="size-4" />,
			};
		default:
			return {
				title: "",
				description: "",
				icon: null,
			};
	}
}

export function BranchActionDialog({
	open,
	state,
	isPending = false,
	onOpenChange,
	onContinueWithoutStash,
	onStashTrackedAndContinue,
	onStashAllAndContinue,
}: BranchActionDialogProps) {
	const copy = getDialogCopy(state);
	const isDirtyUncommitted = state?.kind === "dirty-uncommitted";
	const isDirtyUntracked = state?.kind === "dirty-untracked";

	return (
		<BranchAlertDialog open={open} onOpenChange={onOpenChange}>
			<EnterEnabledAlertDialogContent className="max-w-[360px] gap-0 p-0">
				<AlertDialogHeader className="px-4 pt-4 pb-2">
					<div className="mb-3 flex size-8 items-center justify-center rounded-md bg-muted text-muted-foreground">
						{copy.icon}
					</div>
					<AlertDialogTitle className="font-medium">{copy.title}</AlertDialogTitle>
					<AlertDialogDescription className="whitespace-pre-line">
						{copy.description}
					</AlertDialogDescription>
				</AlertDialogHeader>
				<AlertDialogFooter className="px-4 pb-4 pt-2 flex-row justify-end gap-2">
					<Button
						variant="ghost"
						size="sm"
						className="h-7 px-3 text-xs"
						onClick={() => onOpenChange(false)}
						disabled={isPending}
					>
						閉じる
					</Button>
					{isDirtyUncommitted && onContinueWithoutStash ? (
						<Button
							variant="outline"
							size="sm"
							className="h-7 px-3 text-xs"
							onClick={onContinueWithoutStash}
							disabled={isPending}
						>
							{copy.secondaryLabel}
						</Button>
					) : null}
					{isDirtyUntracked && onContinueWithoutStash ? (
						<Button
							variant="outline"
							size="sm"
							className="h-7 px-3 text-xs"
							onClick={onContinueWithoutStash}
							disabled={isPending}
						>
							{copy.secondaryLabel}
						</Button>
					) : null}
					{isDirtyUncommitted && onStashTrackedAndContinue ? (
						<Button
							size="sm"
							className="h-7 px-3 text-xs"
							onClick={onStashTrackedAndContinue}
							disabled={isPending}
						>
							{copy.primaryLabel}
						</Button>
					) : null}
					{isDirtyUntracked && onStashAllAndContinue ? (
						<Button
							size="sm"
							className="h-7 px-3 text-xs"
							onClick={onStashAllAndContinue}
							disabled={isPending}
						>
							{copy.primaryLabel}
						</Button>
					) : null}
				</AlertDialogFooter>
			</EnterEnabledAlertDialogContent>
		</BranchAlertDialog>
	);
}
