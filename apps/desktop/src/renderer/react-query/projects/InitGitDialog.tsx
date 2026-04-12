import {
	AlertDialog,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "@superset/ui/alert-dialog";
import { Button } from "@superset/ui/button";
import { useGitInitDialogStore } from "renderer/stores/git-init-dialog";

export function InitGitDialog() {
	const { isOpen, isPending, paths, onConfirm, onCancel } =
		useGitInitDialogStore();

	const isSingle = paths.length === 1;

	return (
		<AlertDialog
			open={isOpen}
			onOpenChange={(open) => {
				if (!open && !isPending) onCancel?.();
			}}
		>
			<AlertDialogContent>
				<AlertDialogHeader>
					<AlertDialogTitle>Git リポジトリを初期化しますか?</AlertDialogTitle>
					<AlertDialogDescription asChild>
						<div className="space-y-2">
							{isSingle ? (
								<p>
									<span className="font-medium text-foreground">
										{paths[0]?.split("/").pop()}
									</span>{" "}
									は Git リポジトリではありません。初期化しますか?
								</p>
							) : (
								<>
									<p>
										以下のフォルダは Git リポジトリではありません。初期化しますか?
									</p>
									<ul className="list-disc pl-4 space-y-1">
										{paths.map((p) => (
											<li key={p}>
												<span className="font-medium text-foreground">
													{p.split("/").pop()}
												</span>
												<span className="text-xs ml-1 text-muted-foreground">
													{p}
												</span>
											</li>
										))}
									</ul>
								</>
							)}
						</div>
					</AlertDialogDescription>
				</AlertDialogHeader>
				<AlertDialogFooter>
					<Button
						variant="outline"
						disabled={isPending}
						onClick={() => onCancel?.()}
					>
						キャンセル
					</Button>
					<Button disabled={isPending} onClick={() => onConfirm?.()}>
						{isPending ? "初期化中..." : "Git を初期化"}
					</Button>
				</AlertDialogFooter>
			</AlertDialogContent>
		</AlertDialog>
	);
}
