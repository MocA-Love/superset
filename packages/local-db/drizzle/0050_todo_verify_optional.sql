PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_todo_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text,
	`workspace_id` text NOT NULL,
	`title` text NOT NULL,
	`description` text NOT NULL,
	`goal` text NOT NULL,
	`verify_command` text,
	`max_iterations` integer DEFAULT 10 NOT NULL,
	`max_wall_clock_sec` integer DEFAULT 1800 NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`phase` text,
	`iteration` integer DEFAULT 0 NOT NULL,
	`attached_pane_id` text,
	`attached_tab_id` text,
	`verdict_passed` integer,
	`verdict_reason` text,
	`verdict_failing_test` text,
	`artifact_path` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`started_at` integer,
	`completed_at` integer,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_todo_sessions`("id", "project_id", "workspace_id", "title", "description", "goal", "verify_command", "max_iterations", "max_wall_clock_sec", "status", "phase", "iteration", "attached_pane_id", "attached_tab_id", "verdict_passed", "verdict_reason", "verdict_failing_test", "artifact_path", "created_at", "updated_at", "started_at", "completed_at") SELECT "id", "project_id", "workspace_id", "title", "description", "goal", "verify_command", "max_iterations", "max_wall_clock_sec", "status", "phase", "iteration", "attached_pane_id", "attached_tab_id", "verdict_passed", "verdict_reason", "verdict_failing_test", "artifact_path", "created_at", "updated_at", "started_at", "completed_at" FROM `todo_sessions`;--> statement-breakpoint
DROP TABLE `todo_sessions`;--> statement-breakpoint
ALTER TABLE `__new_todo_sessions` RENAME TO `todo_sessions`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `todo_sessions_workspace_idx` ON `todo_sessions` (`workspace_id`);--> statement-breakpoint
CREATE INDEX `todo_sessions_status_idx` ON `todo_sessions` (`status`);--> statement-breakpoint
CREATE INDEX `todo_sessions_created_at_idx` ON `todo_sessions` (`created_at`);