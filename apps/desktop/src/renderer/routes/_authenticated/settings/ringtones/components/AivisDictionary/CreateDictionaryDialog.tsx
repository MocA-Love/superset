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
import { useState } from "react";
import { electronTrpc } from "renderer/lib/electron-trpc";

interface Props {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	onCreated?: (uuid: string) => void;
}

export function CreateDictionaryDialog({
	open,
	onOpenChange,
	onCreated,
}: Props) {
	const utils = electronTrpc.useUtils();
	const create = electronTrpc.aivis.dictionary.create.useMutation({
		onSuccess: async ({ uuid }) => {
			await utils.aivis.dictionary.list.invalidate();
			onCreated?.(uuid);
			onOpenChange(false);
			setName("");
			setDescription("");
		},
	});

	const [name, setName] = useState("");
	const [description, setDescription] = useState("");

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>新規ユーザー辞書</DialogTitle>
					<DialogDescription>
						空の辞書を作成します。作成後に単語を追加してください。
					</DialogDescription>
				</DialogHeader>
				<div className="space-y-3">
					<div className="space-y-1.5">
						<Label htmlFor="new-dict-name">名前</Label>
						<Input
							id="new-dict-name"
							value={name}
							onChange={(e) => setName(e.target.value)}
							maxLength={100}
							placeholder="project-terms"
						/>
					</div>
					<div className="space-y-1.5">
						<Label htmlFor="new-dict-desc">説明 (任意)</Label>
						<Input
							id="new-dict-desc"
							value={description}
							onChange={(e) => setDescription(e.target.value)}
							maxLength={500}
							placeholder="プロジェクト固有名詞"
						/>
					</div>
					{create.error && (
						<p className="text-sm text-destructive">{create.error.message}</p>
					)}
				</div>
				<DialogFooter>
					<Button
						variant="outline"
						onClick={() => onOpenChange(false)}
						disabled={create.isPending}
					>
						キャンセル
					</Button>
					<Button
						onClick={() =>
							create.mutate({
								name: name.trim(),
								description: description.trim(),
							})
						}
						disabled={create.isPending || !name.trim()}
					>
						{create.isPending ? "作成中…" : "作成"}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
