import { Button } from "@superset/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@superset/ui/dialog";
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
	const handleConfirm = async () => {
		await onConfirm();
	};

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-sm">
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
						onClick={handleConfirm}
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
