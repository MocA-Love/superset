import { Button } from "@superset/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@superset/ui/dialog";
import { Input } from "@superset/ui/input";
import { Label } from "@superset/ui/label";
import { useEffect, useId, useRef, useState } from "react";
import { LuLoaderCircle } from "react-icons/lu";

interface RenameRingtoneDialogProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	currentName: string;
	onSubmit: (name: string) => Promise<void>;
	isSubmitting: boolean;
	errorMessage?: string | null;
}

export function RenameRingtoneDialog({
	open,
	onOpenChange,
	currentName,
	onSubmit,
	isSubmitting,
	errorMessage,
}: RenameRingtoneDialogProps) {
	const nameId = useId();
	const [name, setName] = useState(currentName);

	// Swallow stray pointer/focus events that fire right after opening from a
	// DropdownMenu item (otherwise the menu's closing pointerup is treated as
	// an outside-click and dismisses this dialog immediately).
	const openedAtRef = useRef(0);
	useEffect(() => {
		if (open) openedAtRef.current = Date.now();
	}, [open]);
	const guardOutside = (event: Event) => {
		if (Date.now() - openedAtRef.current < 300) {
			event.preventDefault();
		}
	};

	useEffect(() => {
		if (open) {
			setName(currentName);
		}
	}, [open, currentName]);

	const trimmed = name.trim();
	const canSubmit =
		trimmed.length > 0 && trimmed !== currentName && !isSubmitting;

	const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		if (!canSubmit) return;
		await onSubmit(trimmed);
	};

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent
				className="sm:max-w-sm"
				onPointerDownOutside={guardOutside}
				onInteractOutside={guardOutside}
				onFocusOutside={guardOutside}
			>
				<DialogHeader>
					<DialogTitle>Rename custom audio</DialogTitle>
					<DialogDescription>
						Choose a new display name for this custom notification sound.
					</DialogDescription>
				</DialogHeader>

				<form onSubmit={handleSubmit} className="space-y-4">
					<div className="space-y-2">
						<Label htmlFor={nameId}>Name</Label>
						<Input
							id={nameId}
							value={name}
							onChange={(event) => setName(event.target.value)}
							maxLength={80}
							autoFocus
							disabled={isSubmitting}
						/>
					</div>

					{errorMessage && (
						<p className="text-sm text-destructive break-words">
							{errorMessage}
						</p>
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
						<Button type="submit" disabled={!canSubmit}>
							{isSubmitting && (
								<LuLoaderCircle className="mr-2 h-4 w-4 animate-spin" />
							)}
							Save
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}
