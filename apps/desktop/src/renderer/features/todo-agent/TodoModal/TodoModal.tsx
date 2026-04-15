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
import { toast } from "@superset/ui/sonner";
import { Textarea } from "@superset/ui/textarea";
import { useCallback, useState } from "react";
import { electronTrpc } from "renderer/lib/electron-trpc";
import { EnhanceButton } from "./components/EnhanceButton";

interface TodoModalProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	workspaceId: string;
	projectId?: string;
}

const DEFAULT_VERIFY_COMMAND = "";
const DEFAULT_MAX_ITERATIONS = 10;
const DEFAULT_MAX_MINUTES = 30;

/**
 * Creation form for a new TODO autonomous session. Collects the minimum
 * needed for the supervisor to start a run: description, goal, verify
 * command, and budget. On submit, creates a DB row via trpc and closes.
 * The actual execution handoff (pane attach + start) is done separately
 * from the TodoPanel once the user opens it.
 */
export function TodoModal({
	open,
	onOpenChange,
	workspaceId,
	projectId,
}: TodoModalProps) {
	const [title, setTitle] = useState("");
	const [description, setDescription] = useState("");
	const [goal, setGoal] = useState("");
	const [verifyCommand, setVerifyCommand] = useState(DEFAULT_VERIFY_COMMAND);
	const [maxIterations, setMaxIterations] = useState(DEFAULT_MAX_ITERATIONS);
	const [maxMinutes, setMaxMinutes] = useState(DEFAULT_MAX_MINUTES);
	const [submitting, setSubmitting] = useState(false);

	const utils = electronTrpc.useUtils();
	const create = electronTrpc.todoAgent.create.useMutation({
		onSuccess: async () => {
			await utils.todoAgent.list.invalidate({ workspaceId });
		},
	});

	const reset = useCallback(() => {
		setTitle("");
		setDescription("");
		setGoal("");
		setVerifyCommand(DEFAULT_VERIFY_COMMAND);
		setMaxIterations(DEFAULT_MAX_ITERATIONS);
		setMaxMinutes(DEFAULT_MAX_MINUTES);
		setSubmitting(false);
	}, []);

	const handleOpenChange = useCallback(
		(next: boolean) => {
			if (!next) reset();
			onOpenChange(next);
		},
		[onOpenChange, reset],
	);

	const canSubmit =
		title.trim().length > 0 &&
		description.trim().length > 0 &&
		maxIterations >= 1 &&
		maxMinutes >= 1 &&
		!submitting &&
		workspaceId.length > 0;

	const hasVerify = verifyCommand.trim().length > 0;
	const hasGoal = goal.trim().length > 0;

	const handleSubmit = useCallback(async () => {
		if (!canSubmit) return;
		setSubmitting(true);
		try {
			await create.mutateAsync({
				workspaceId,
				projectId,
				title: title.trim(),
				description: description.trim(),
				goal: hasGoal ? goal.trim() : undefined,
				verifyCommand: hasVerify ? verifyCommand.trim() : undefined,
				maxIterations,
				maxWallClockSec: maxMinutes * 60,
			});
			toast.success("TODO セッションを作成しました");
			handleOpenChange(false);
		} catch (error) {
			const message =
				error instanceof Error ? error.message : "作成に失敗しました";
			toast.error(message);
			setSubmitting(false);
		}
	}, [
		hasGoal,
		hasVerify,
		canSubmit,
		create,
		description,
		goal,
		handleOpenChange,
		maxIterations,
		maxMinutes,
		projectId,
		title,
		verifyCommand,
		workspaceId,
	]);

	return (
		<Dialog open={open} onOpenChange={handleOpenChange}>
			<DialogContent className="max-w-xl">
				<DialogHeader>
					<DialogTitle>新しい自律 TODO</DialogTitle>
					<DialogDescription>
						自律的な Claude Code セッションを起動します。Verify コマンドを
						指定した場合はその終了コードが 0 になるか予算上限に達するまで
						ループします。空欄の場合は単発タスクとして 1 ターンだけ実行します
						（調査・リサーチ向け）。実行中は TODO パネルから状況を確認でき、
						ワーカーのターミナルに直接入力して介入できます。
					</DialogDescription>
				</DialogHeader>

				<div className="flex flex-col gap-4 py-2">
					<div className="flex flex-col gap-1.5">
						<Label htmlFor="todo-title">タイトル</Label>
						<Input
							id="todo-title"
							value={title}
							onChange={(e) => setTitle(e.target.value)}
							placeholder="例: Issue #123 のログインリダイレクト問題を修正"
							maxLength={200}
							autoFocus
						/>
					</div>

					<div className="flex flex-col gap-1.5">
						<div className="flex items-center justify-between">
							<Label htmlFor="todo-description">やって欲しいこと</Label>
							<EnhanceButton
								value={description}
								onEnhanced={setDescription}
								kind="description"
							/>
						</div>
						<Textarea
							id="todo-description"
							value={description}
							onChange={(e) => setDescription(e.target.value)}
							placeholder="タスクの内容を記述してください。背景や制約を多めに書くほど、エージェントが必要とするイテレーション数が減ります。"
							rows={4}
						/>
					</div>

					<div className="flex flex-col gap-1.5">
						<div className="flex items-center justify-between">
							<Label htmlFor="todo-goal">
								ゴール{" "}
								<span className="text-muted-foreground font-normal">（任意）</span>
							</Label>
							<EnhanceButton
								value={goal}
								onEnhanced={setGoal}
								kind="goal"
							/>
						</div>
						<Textarea
							id="todo-goal"
							value={goal}
							onChange={(e) => setGoal(e.target.value)}
							placeholder="例: ○○の調査結果がまとまっている / △△のバグが再現しなくなっている（空欄なら『やって欲しいこと』の完了をゴールとします）"
							rows={3}
						/>
					</div>

					<div className="flex flex-col gap-1.5">
						<Label htmlFor="todo-verify">
							Verify コマンド{" "}
							<span className="text-muted-foreground font-normal">（任意）</span>
						</Label>
						<Input
							id="todo-verify"
							value={verifyCommand}
							onChange={(e) => setVerifyCommand(e.target.value)}
							placeholder="例: bun test（空欄なら単発実行）"
						/>
						<p className="text-xs text-muted-foreground">
							指定した場合は worktree で実行され、終了コード 0 で完了判定されます。
							調査タスクなど「完了判定がテストで出せない」場合は空欄にしてください。
						</p>
					</div>

					{hasVerify && (
						<div className="grid grid-cols-2 gap-4">
							<div className="flex flex-col gap-1.5">
								<Label htmlFor="todo-iter">最大イテレーション数</Label>
								<Input
									id="todo-iter"
									type="number"
									min={1}
									max={100}
									value={maxIterations}
									onChange={(e) =>
										setMaxIterations(Number(e.target.value) || 1)
									}
								/>
							</div>
							<div className="flex flex-col gap-1.5">
								<Label htmlFor="todo-minutes">壁時計上限（分）</Label>
								<Input
									id="todo-minutes"
									type="number"
									min={1}
									max={240}
									value={maxMinutes}
									onChange={(e) =>
										setMaxMinutes(Number(e.target.value) || 1)
									}
								/>
							</div>
						</div>
					)}
				</div>

				<DialogFooter>
					<Button
						type="button"
						variant="ghost"
						onClick={() => handleOpenChange(false)}
						disabled={submitting}
					>
						キャンセル
					</Button>
					<Button
						type="button"
						onClick={handleSubmit}
						disabled={!canSubmit}
					>
						{submitting ? "作成中…" : "作成"}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
