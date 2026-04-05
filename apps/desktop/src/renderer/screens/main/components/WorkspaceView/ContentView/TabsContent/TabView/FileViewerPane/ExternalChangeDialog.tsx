import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
	EnterEnabledAlertDialogContent,
} from "@superset/ui/alert-dialog";

interface ExternalChangeDialogProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	onOverwrite: () => void;
	onCompare: () => void;
}

export function ExternalChangeDialog({
	open,
	onOpenChange,
	onOverwrite,
	onCompare,
}: ExternalChangeDialogProps) {
	return (
		<AlertDialog open={open} onOpenChange={onOpenChange}>
			<EnterEnabledAlertDialogContent>
				<AlertDialogHeader>
					<AlertDialogTitle>File changed on disk</AlertDialogTitle>
					<AlertDialogDescription>
						The file has been modified externally since you started editing.
						Would you like to overwrite the file or compare the differences?
					</AlertDialogDescription>
				</AlertDialogHeader>
				<AlertDialogFooter>
					<AlertDialogCancel>Cancel</AlertDialogCancel>
					<AlertDialogAction variant="outline" onClick={onCompare}>
						Compare
					</AlertDialogAction>
					<AlertDialogAction onClick={onOverwrite}>Overwrite</AlertDialogAction>
				</AlertDialogFooter>
			</EnterEnabledAlertDialogContent>
		</AlertDialog>
	);
}
