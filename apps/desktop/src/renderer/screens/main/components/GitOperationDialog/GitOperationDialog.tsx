import {
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
	AlertDialog as GitAlertDialog,
	EnterEnabledAlertDialogContent,
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

function toneToIcon(tone: GitOperationDialogTone | undefined) {
	switch (tone) {
		case "danger":
			return {
				node: <HiExclamationTriangle className="size-4" />,
				bg: "bg-destructive/20 text-destructive",
			};
		case "warn":
			return {
				node: <LuCircleAlert className="size-4" />,
				bg: "bg-amber-500/20 text-amber-500",
			};
		case "ok":
			return {
				node: <LuCircleCheck className="size-4" />,
				bg: "bg-emerald-500/20 text-emerald-500",
			};
		case "info":
			return {
				node: <LuInfo className="size-4" />,
				bg: "bg-sky-500/20 text-sky-500",
			};
		default:
			return {
				node: <LuShieldAlert className="size-4" />,
				bg: "bg-muted text-muted-foreground",
			};
	}
}

function variantClass(
	variant: GitOperationDialogActionVariant | undefined,
): string {
	switch (variant) {
		case "danger":
			return "h-7 px-3 text-xs bg-destructive text-destructive-foreground hover:bg-destructive/90";
		case "warn":
			return "h-7 px-3 text-xs bg-amber-500/90 text-white hover:bg-amber-500";
		case "ok":
			return "h-7 px-3 text-xs bg-emerald-600 text-white hover:bg-emerald-600/90";
		case "accent":
			return "h-7 px-3 text-xs bg-sky-600 text-white hover:bg-sky-600/90";
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
	const icon = toneToIcon(spec?.tone);

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
							<div
								className={`mb-3 flex size-8 items-center justify-center rounded-md ${icon.bg}`}
							>
								{spec.icon ?? icon.node}
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
						<AlertDialogFooter className="flex-row flex-wrap justify-end gap-2 px-4 pb-4 pt-2">
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
