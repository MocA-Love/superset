import {
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
	EnterEnabledAlertDialogContent,
	AlertDialog as GitAlertDialog,
} from "@superset/ui/alert-dialog";
import { Button } from "@superset/ui/button";
import { HiExclamationTriangle } from "react-icons/hi2";
import {
	LuCircleAlert,
	LuCircleCheck,
	LuInfo,
	LuShieldAlert,
} from "react-icons/lu";
import {
	type GitOperationDialogAction,
	type GitOperationDialogActionVariant,
	type GitOperationDialogTone,
	useGitOperationDialogStore,
} from "renderer/stores/git-operation-dialog";

// Icons stay monochrome (bg-muted / text-muted-foreground) to match the
// existing BranchActionDialog. Tone still drives the icon glyph so callers can
// signal intent, but the color palette is uniform across kinds.
function toneToIcon(tone: GitOperationDialogTone | undefined) {
	switch (tone) {
		case "danger":
			return <HiExclamationTriangle className="size-4" />;
		case "warn":
			return <LuCircleAlert className="size-4" />;
		case "ok":
			return <LuCircleCheck className="size-4" />;
		case "info":
			return <LuInfo className="size-4" />;
		default:
			return <LuShieldAlert className="size-4" />;
	}
}

// Map our palette to shadcn Button's native variant prop so we don't need to
// override classes (which previously left the outline borders from the
// hardcoded variant="outline" bleeding into primary/destructive buttons).
// "destructive" stays available for truly destructive actions (force push,
// force unlock, discard). All other action variants collapse to
// default/outline/ghost — no custom colors.
type ShadcnButtonVariant = "default" | "destructive" | "outline" | "ghost";

function toShadcnVariant(
	variant: GitOperationDialogActionVariant | undefined,
): ShadcnButtonVariant {
	switch (variant) {
		case "destructive":
			return "destructive";
		case "outline":
			return "outline";
		case "ghost":
			return "ghost";
		default:
			return "default";
	}
}

function ActionButton({
	action,
	isPending,
	dialogId,
}: {
	action: GitOperationDialogAction;
	isPending: boolean;
	dialogId: number;
}) {
	const onClick = async () => {
		const store = useGitOperationDialogStore.getState();
		try {
			const result = action.onClick();
			if (result instanceof Promise) {
				store.setPending(true, dialogId);
				await result;
			}
		} catch (err) {
			// Actions normally delegate error reporting to their own mutation
			// onError handlers. Anything reaching here is an unexpected throw —
			// surface it to the console instead of silently eating it.
			console.error("[GitOperationDialog] action threw", err);
		} finally {
			// Both setPending and close are scoped to this button's dialogId so
			// that a late-running action cannot clobber a dialog the user has
			// opened in the meantime (e.g. if the action opens another dialog).
			useGitOperationDialogStore.getState().setPending(false, dialogId);
			useGitOperationDialogStore.getState().close(dialogId);
		}
	};

	return (
		<Button
			type="button"
			variant={toShadcnVariant(action.variant)}
			size="sm"
			className="h-7 px-3 text-xs"
			disabled={isPending || action.disabled}
			onClick={() => {
				void onClick();
			}}
		>
			{action.label}
		</Button>
	);
}

export function GitOperationDialog() {
	const spec = useGitOperationDialogStore((s) => s.spec);
	const dialogId = useGitOperationDialogStore((s) => s.dialogId);
	const isPending = useGitOperationDialogStore((s) => s.isPending);
	const close = useGitOperationDialogStore((s) => s.close);

	const open = spec !== null;
	const iconNode = toneToIcon(spec?.tone);

	return (
		<GitAlertDialog
			open={open}
			onOpenChange={(nextOpen) => {
				if (!nextOpen && !isPending) close(dialogId);
			}}
		>
			<EnterEnabledAlertDialogContent className="max-w-[420px] gap-0 p-0">
				{spec ? (
					<>
						<AlertDialogHeader className="px-4 pt-4 pb-2">
							<div className="mb-3 flex size-8 items-center justify-center rounded-md bg-muted text-muted-foreground">
								{spec.icon ?? iconNode}
							</div>
							<AlertDialogTitle className="font-medium">
								{spec.title}
							</AlertDialogTitle>
							{spec.description ? (
								<AlertDialogDescription className="whitespace-pre-line">
									{spec.description}
								</AlertDialogDescription>
							) : null}
						</AlertDialogHeader>
						{spec.extraContent ? (
							<div className="px-4 pb-2">{spec.extraContent}</div>
						) : null}
						{spec.details ? (
							<div className="mx-4 mb-2 max-h-[140px] overflow-auto rounded-md border border-border bg-muted/40 px-2 py-1 font-mono text-[10px] leading-tight text-muted-foreground">
								<pre className="whitespace-pre-wrap break-words">
									{spec.details}
								</pre>
							</div>
						) : null}
						<AlertDialogFooter className="flex-row justify-end gap-2 px-4 pb-4 pt-2">
							{spec.hideDismiss ? null : (
								<Button
									type="button"
									variant="ghost"
									size="sm"
									className="h-7 px-3 text-xs"
									disabled={isPending}
									onClick={() => close(dialogId)}
								>
									{spec.dismissLabel ?? "閉じる"}
								</Button>
							)}
							{spec.tertiaryAction ? (
								<ActionButton
									action={spec.tertiaryAction}
									isPending={isPending}
									dialogId={dialogId}
								/>
							) : null}
							{spec.secondaryAction ? (
								<ActionButton
									action={spec.secondaryAction}
									isPending={isPending}
									dialogId={dialogId}
								/>
							) : null}
							{spec.primaryAction ? (
								<ActionButton
									action={spec.primaryAction}
									isPending={isPending}
									dialogId={dialogId}
								/>
							) : null}
						</AlertDialogFooter>
					</>
				) : null}
			</EnterEnabledAlertDialogContent>
		</GitAlertDialog>
	);
}
