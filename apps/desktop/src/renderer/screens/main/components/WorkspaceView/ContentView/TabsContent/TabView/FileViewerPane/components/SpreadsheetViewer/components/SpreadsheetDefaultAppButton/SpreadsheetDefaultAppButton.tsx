import { Button } from "@superset/ui/button";
import { toast } from "@superset/ui/sonner";
import { HiArrowTopRightOnSquare } from "react-icons/hi2";
import { electronTrpc } from "renderer/lib/electron-trpc";

interface SpreadsheetDefaultAppButtonProps {
	absoluteFilePath: string;
}

export function SpreadsheetDefaultAppButton({
	absoluteFilePath,
}: SpreadsheetDefaultAppButtonProps) {
	const openInDefaultApp = electronTrpc.external.openInDefaultApp.useMutation({
		onError: (error) => {
			toast.error("Failed to open in default app", {
				description: error.message,
			});
		},
	});

	return (
		<Button
			type="button"
			variant="outline"
			size="sm"
			className="h-7 gap-1.5 text-xs"
			onClick={() => openInDefaultApp.mutate(absoluteFilePath)}
			disabled={!absoluteFilePath || openInDefaultApp.isPending}
		>
			<HiArrowTopRightOnSquare className="size-3.5" />
			<span>既定アプリで開く</span>
		</Button>
	);
}
