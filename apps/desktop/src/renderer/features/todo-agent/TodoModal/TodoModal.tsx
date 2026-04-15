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

interface TodoModalProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	workspaceId: string;
	projectId?: string;
}

const DEFAULT_VERIFY_COMMAND = "bun test";
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
		goal.trim().length > 0 &&
		verifyCommand.trim().length > 0 &&
		maxIterations >= 1 &&
		maxMinutes >= 1 &&
		!submitting;

	const handleSubmit = useCallback(async () => {
		if (!canSubmit) return;
		setSubmitting(true);
		try {
			await create.mutateAsync({
				workspaceId,
				projectId,
				title: title.trim(),
				description: description.trim(),
				goal: goal.trim(),
				verifyCommand: verifyCommand.trim(),
				maxIterations,
				maxWallClockSec: maxMinutes * 60,
			});
			toast.success("TODO session created");
			handleOpenChange(false);
		} catch (error) {
			const message =
				error instanceof Error ? error.message : "Failed to create TODO";
			toast.error(message);
			setSubmitting(false);
		}
	}, [
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
					<DialogTitle>New autonomous TODO</DialogTitle>
					<DialogDescription>
						An autonomous Claude Code session will run until the verify
						command exits 0 or the budget is exhausted. You can watch and
						intervene from the TODO panel while it runs.
					</DialogDescription>
				</DialogHeader>

				<div className="flex flex-col gap-4 py-2">
					<div className="flex flex-col gap-1.5">
						<Label htmlFor="todo-title">Title</Label>
						<Input
							id="todo-title"
							value={title}
							onChange={(e) => setTitle(e.target.value)}
							placeholder="Fix issue #123: login redirect loop"
							maxLength={200}
							autoFocus
						/>
					</div>

					<div className="flex flex-col gap-1.5">
						<Label htmlFor="todo-description">What should be done?</Label>
						<Textarea
							id="todo-description"
							value={description}
							onChange={(e) => setDescription(e.target.value)}
							placeholder="Describe the task. The more context you give, the fewer iterations the agent will need."
							rows={4}
						/>
					</div>

					<div className="flex flex-col gap-1.5">
						<Label htmlFor="todo-goal">Clear goal (acceptance criteria)</Label>
						<Textarea
							id="todo-goal"
							value={goal}
							onChange={(e) => setGoal(e.target.value)}
							placeholder="The task is done when: ..."
							rows={3}
						/>
					</div>

					<div className="flex flex-col gap-1.5">
						<Label htmlFor="todo-verify">Verify command</Label>
						<Input
							id="todo-verify"
							value={verifyCommand}
							onChange={(e) => setVerifyCommand(e.target.value)}
							placeholder={DEFAULT_VERIFY_COMMAND}
						/>
						<p className="text-xs text-muted-foreground">
							Run in the worktree. Exit code 0 = done.
						</p>
					</div>

					<div className="grid grid-cols-2 gap-4">
						<div className="flex flex-col gap-1.5">
							<Label htmlFor="todo-iter">Max iterations</Label>
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
							<Label htmlFor="todo-minutes">Wall-clock (minutes)</Label>
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
				</div>

				<DialogFooter>
					<Button
						type="button"
						variant="ghost"
						onClick={() => handleOpenChange(false)}
						disabled={submitting}
					>
						Cancel
					</Button>
					<Button
						type="button"
						onClick={handleSubmit}
						disabled={!canSubmit}
					>
						{submitting ? "Creating…" : "Create TODO"}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
