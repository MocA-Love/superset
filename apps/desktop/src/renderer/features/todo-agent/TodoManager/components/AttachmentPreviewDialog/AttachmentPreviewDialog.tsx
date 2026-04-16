import { Button } from "@superset/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@superset/ui/dialog";
import { toast } from "@superset/ui/sonner";
import { electronTrpc } from "renderer/lib/electron-trpc";
import type { AttachmentRef } from "../../utils/attachmentRefs";

interface AttachmentPreviewDialogProps {
	attachment: AttachmentRef | null;
	open: boolean;
	onOpenChange: (open: boolean) => void;
}

/**
 * Nested modal that previews a TODO attachment image. Mounting the
 * preview as its own Dialog keeps the parent Agent Manager dialog
 * open underneath — Radix routes outside-clicks and Esc to the
 * top-most dialog only, which is the requested behavior.
 */
export function AttachmentPreviewDialog({
	attachment,
	open,
	onOpenChange,
}: AttachmentPreviewDialogProps) {
	const enabled = open && attachment != null;
	const { data, isLoading, error } =
		electronTrpc.todoAgent.readAttachment.useQuery(
			{ path: attachment?.path ?? "" },
			{ enabled, retry: false, staleTime: 60_000 },
		);

	const copyPath = async () => {
		if (!attachment) return;
		try {
			await navigator.clipboard.writeText(attachment.path);
			toast.success("パスをコピーしました");
		} catch (err) {
			toast.error(err instanceof Error ? err.message : "コピーに失敗しました");
		}
	};

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="w-[min(960px,calc(100vw-4rem))] max-w-[calc(100vw-4rem)] max-h-[90vh] p-0 gap-0 overflow-hidden flex flex-col rounded-xl">
				<DialogTitle className="sr-only">
					{attachment?.name ?? "添付プレビュー"}
				</DialogTitle>
				<div className="flex items-center justify-between border-b px-4 h-11 shrink-0 gap-2">
					<div className="min-w-0 flex flex-col">
						<div className="text-sm font-medium truncate">
							{attachment?.name}
						</div>
						{attachment ? (
							<div className="text-[10px] text-muted-foreground truncate">
								{attachment.path}
							</div>
						) : null}
					</div>
					<div className="flex items-center gap-1.5 shrink-0">
						<Button
							type="button"
							size="sm"
							variant="ghost"
							className="h-7 px-2 text-[11px]"
							onClick={copyPath}
						>
							パスをコピー
						</Button>
					</div>
				</div>
				<div className="flex-1 min-h-0 overflow-auto bg-muted/20 flex items-center justify-center p-4">
					{!attachment ? null : isLoading ? (
						<div className="text-xs text-muted-foreground">読み込み中…</div>
					) : error ? (
						<div className="text-xs text-destructive">
							読み込みに失敗しました: {error.message}
						</div>
					) : data ? (
						<img
							src={`data:${data.mimeType};base64,${data.dataBase64}`}
							alt={attachment.alt || attachment.name}
							className="max-w-full max-h-[80vh] object-contain rounded-md shadow-sm"
						/>
					) : null}
				</div>
			</DialogContent>
		</Dialog>
	);
}
