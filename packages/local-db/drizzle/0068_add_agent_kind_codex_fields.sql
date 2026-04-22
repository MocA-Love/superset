ALTER TABLE `todo_schedules` ADD `agent_kind` text DEFAULT 'claude' NOT NULL;--> statement-breakpoint
ALTER TABLE `todo_schedules` ADD `codex_model` text;--> statement-breakpoint
ALTER TABLE `todo_schedules` ADD `codex_effort` text;--> statement-breakpoint
ALTER TABLE `todo_sessions` ADD `agent_kind` text DEFAULT 'claude' NOT NULL;--> statement-breakpoint
ALTER TABLE `todo_sessions` ADD `codex_model` text;--> statement-breakpoint
ALTER TABLE `todo_sessions` ADD `codex_effort` text;