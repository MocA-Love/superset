import type { PullRequestComment } from "@superset/local-db";
import { Avatar, AvatarFallback, AvatarImage } from "@superset/ui/avatar";
import { Button } from "@superset/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@superset/ui/dialog";
import { Textarea } from "@superset/ui/textarea";
import { useEffect, useRef, useState } from "react";
import { LuLoaderCircle } from "react-icons/lu";
import { getCommentAvatarFallback } from "../../utils";
import { CommentBody } from "../CommentBody";

interface ReplyDialogProps {
	comment: PullRequestComment | null;
	open: boolean;
	onOpenChange: (open: boolean) => void;
	onSubmit: (body: string) => Promise<void> | void;
	isSubmitting: boolean;
	onOpenUrl?: (url: string, e: React.MouseEvent) => void;
}

export function ReplyDialog({
	comment,
	open,
	onOpenChange,
	onSubmit,
	isSubmitting,
	onOpenUrl,
}: ReplyDialogProps) {
	const [body, setBody] = useState("");
	const inFlightRef = useRef(false);

	useEffect(() => {
		if (!open) {
			setBody("");
			inFlightRef.current = false;
		}
	}, [open]);

	if (!comment) {
		return null;
	}

	const isReviewThreadReply = Boolean(comment.threadId);
	const trimmed = body.trim();
	const canSubmit = trimmed.length > 0 && !isSubmitting;

	const runSubmit = async () => {
		if (!canSubmit || inFlightRef.current) {
			return;
		}
		inFlightRef.current = true;
		try {
			await onSubmit(trimmed);
		} finally {
			inFlightRef.current = false;
		}
	};

	const handleSubmit = (event: React.FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		void runSubmit();
	};

	const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
		if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
			event.preventDefault();
			void runSubmit();
		}
	};

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="max-w-lg">
				<DialogHeader>
					<DialogTitle>
						{isReviewThreadReply
							? "Reply to review thread"
							: "Reply to comment"}
					</DialogTitle>
					<DialogDescription>
						{isReviewThreadReply
							? "Your reply will be posted to this review thread on GitHub."
							: "Your reply will be posted as a new comment on this pull request."}
					</DialogDescription>
				</DialogHeader>

				<div className="max-h-48 overflow-y-auto rounded-md border border-border/60 bg-muted/30 p-2 text-xs">
					<div className="mb-1 flex items-center gap-1.5">
						<Avatar className="size-4">
							{comment.avatarUrl ? (
								<AvatarImage
									src={comment.avatarUrl}
									alt={comment.authorLogin}
								/>
							) : null}
							<AvatarFallback className="text-[10px] font-medium">
								{getCommentAvatarFallback(comment.authorLogin)}
							</AvatarFallback>
						</Avatar>
						<span className="font-medium text-foreground">
							{comment.authorLogin}
						</span>
						{comment.path ? (
							<span className="truncate text-muted-foreground">
								{comment.path}
								{comment.line ? `:${comment.line}` : ""}
							</span>
						) : null}
					</div>
					<div className="review-comment-body break-words text-xs leading-5 text-muted-foreground">
						<CommentBody body={comment.body} onOpenUrl={onOpenUrl} />
					</div>
				</div>

				<form className="space-y-3" onSubmit={handleSubmit}>
					<Textarea
						value={body}
						onChange={(event) => setBody(event.target.value)}
						onKeyDown={handleKeyDown}
						placeholder="Write a reply..."
						className="min-h-[120px] resize-none text-sm"
						disabled={isSubmitting}
						autoFocus
					/>
					<DialogFooter>
						<Button
							type="button"
							variant="outline"
							onClick={() => onOpenChange(false)}
							disabled={isSubmitting}
						>
							Cancel
						</Button>
						<Button type="submit" disabled={!canSubmit}>
							{isSubmitting ? (
								<LuLoaderCircle className="mr-1 size-3.5 animate-spin" />
							) : null}
							Reply
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}
