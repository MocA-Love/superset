import { Button } from "@superset/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@superset/ui/dialog";
import { useEffect, useRef } from "react";
import { LuLoaderCircle } from "react-icons/lu";

interface DeleteRingtoneDialogProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	ringtoneName: string;
	onConfirm: () => Promise<void> | void;
	isSubmitting: boolean;
	errorMessage?: string | null;
}

export function DeleteRingtoneDialog({
	open,
	onOpenChange,
	ringtoneName,
	onConfirm,
	isSubmitting,
	errorMessage,
}: DeleteRingtoneDialogProps) {
	// Swallow the stray pointer/focus event that arrives right after the dialog
	// opens from a DropdownMenu item — otherwise the menu's closing pointerup
	// is treated as an outside-click and dismisses this dialog immediately.
	const openedAtRef = useRef(0);
	useEffect(() => {
		if (open) openedAtRef.current = Date.now();
	}, [open]);
	const guardOutside = (event: Event) => {
		if (Date.now() - openedAtRef.current < 300) {
			event.preventDefault();
		}
	};

	return (
		<Dialog
			open={open}
			onOpenChange={(next) => {
				if (!next && isSubmitting) return;
				onOpenChange(next);
			}}
		>
			<DialogContent
				className="sm:max-w-sm"
				onPointerDownOutside={guardOutside}
				onInteractOutside={guardOutside}
				onFocusOutside={guardOutside}
			>
				<DialogHeader>
					<DialogTitle>Delete custom audio</DialogTitle>
					<DialogDescription>
						{ringtoneName
							? `Delete “${ringtoneName}”? This cannot be undone.`
							: "Delete the custom notification sound? This cannot be undone."}
					</DialogDescription>
				</DialogHeader>

				{errorMessage && (
					<p className="text-sm text-destructive break-words">{errorMessage}</p>
				)}

				<DialogFooter>
					<Button
						type="button"
						variant="ghost"
						onClick={() => onOpenChange(false)}
						disabled={isSubmitting}
					>
						Cancel
					</Button>
					<Button
						type="button"
						variant="destructive"
						onClick={() => {
							void onConfirm();
						}}
						disabled={isSubmitting}
					>
						{isSubmitting && (
							<LuLoaderCircle className="mr-2 h-4 w-4 animate-spin" />
						)}
						Delete
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
