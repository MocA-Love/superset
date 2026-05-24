import { CLIError, number, string } from "@superset/cli-framework";
import { command } from "../../../lib/command";

function parseDueDate(value: string | undefined): Date | undefined {
	if (!value) return undefined;
	const timestamp = Date.parse(value);
	if (Number.isNaN(timestamp)) {
		throw new CLIError(`--due-date: invalid ISO 8601 date "${value}"`);
	}
	return new Date(timestamp);
}

export default command({
	description: "Create a task",
	options: {
		title: string().required().desc("Task title"),
		description: string().desc("Task description"),
		priority: string()
			.enum("urgent", "high", "medium", "low", "none")
			.desc("Priority"),
		assignee: string().desc("Assignee user ID"),
		statusId: string().desc("Status ID"),
		estimate: number().int().min(1).desc("Story-point estimate"),
		dueDate: string().desc("Due date (ISO 8601)"),
		labels: string().desc("Comma-separated labels"),
		branch: string().desc("Git branch"),
	},
	run: async ({ ctx, options }) => {
		const labels = options.labels
			? options.labels
					.split(",")
					.map((label) => label.trim())
					.filter(Boolean)
			: undefined;
		const result = await ctx.api.task.createFromUi.mutate({
			title: options.title,
			description: options.description ?? undefined,
			priority: options.priority,
			assigneeId: options.assignee ?? undefined,
			statusId: options.statusId ?? undefined,
			estimate: options.estimate ?? undefined,
			dueDate: parseDueDate(options.dueDate),
			labels,
		});

		const task = result.task;
		return {
			data: task,
			message: `Created task ${task?.slug}: ${task?.title}`,
		};
	},
});
