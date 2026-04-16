CREATE TABLE `todo_schedules` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`workspace_id` text,
	`name` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`frequency` text NOT NULL,
	`minute` integer,
	`hour` integer,
	`weekday` integer,
	`monthday` integer,
	`cron_expr` text,
	`title` text NOT NULL,
	`description` text NOT NULL,
	`goal` text,
	`verify_command` text,
	`max_iterations` integer DEFAULT 10 NOT NULL,
	`max_wall_clock_sec` integer DEFAULT 1800 NOT NULL,
	`custom_system_prompt` text,
	`overlap_mode` text DEFAULT 'skip' NOT NULL,
	`auto_sync_before_fire` integer DEFAULT false NOT NULL,
	`last_run_at` integer,
	`last_run_session_id` text,
	`next_run_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `todo_schedules_project_idx` ON `todo_schedules` (`project_id`);--> statement-breakpoint
CREATE INDEX `todo_schedules_workspace_idx` ON `todo_schedules` (`workspace_id`);--> statement-breakpoint
CREATE INDEX `todo_schedules_enabled_next_run_idx` ON `todo_schedules` (`enabled`,`next_run_at`);