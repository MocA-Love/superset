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

// Only shadcn's base variants are used. "destructive" stays available for
// truly destructive actions (force push, force unlock, discard). All other
// action variants collapse to default/outline/ghost — no custom colors.
function variantClass(
	variant: GitOperationDialogActionVariant | undefined,
): string {
	switch (variant) {
		case "destructive":
			return "h-7 px-3 text-xs bg-destructive text-destructive-foreground hover:bg-destructive/90";
		case "outline":
			return "h-7 px-3 text-xs border border-border bg-transparent hover:bg-accent";
		case "ghost":
			return "h-7 px-3 text-xs text-muted-foreground hover:bg-accent";
		default:
			return "h-7 px-3 text-xs";
	}
}

function ActionButton({
	action,
	isPending,
	close,
}: {
	action: GitOperationDialogAction;
	isPending: boolean;
	close: () => void;
}) {
	const onClick = async () => {
		try {
			const result = action.onClick();
			if (result instanceof Promise) {
				useGitOperationDialogStore.getState().setPending(true);
				await result;
			}
		} finally {
			useGitOperationDialogStore.getState().setPending(false);
			close();
		}
	};

	return (
		<Button
			type="button"
			variant="outline"
			size="sm"
			className={variantClass(action.variant)}
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
	const isPending = useGitOperationDialogStore((s) => s.isPending);
	const close = useGitOperationDialogStore((s) => s.close);

	const open = spec !== null;
	const iconNode = toneToIcon(spec?.tone);

	return (
		<GitAlertDialog
			open={open}
			onOpenChange={(nextOpen) => {
				if (!nextOpen && !isPending) close();
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
									onClick={() => close()}
								>
									{spec.dismissLabel ?? "閉じる"}
								</Button>
							)}
							{spec.tertiaryAction ? (
								<ActionButton
									action={spec.tertiaryAction}
									isPending={isPending}
									close={close}
								/>
							) : null}
							{spec.secondaryAction ? (
								<ActionButton
									action={spec.secondaryAction}
									isPending={isPending}
									close={close}
								/>
							) : null}
							{spec.primaryAction ? (
								<ActionButton
									action={spec.primaryAction}
									isPending={isPending}
									close={close}
								/>
							) : null}
						</AlertDialogFooter>
					</>
				) : null}
			</EnterEnabledAlertDialogContent>
		</GitAlertDialog>
	);
}
