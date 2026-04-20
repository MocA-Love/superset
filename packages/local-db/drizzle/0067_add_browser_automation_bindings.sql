CREATE TABLE `browser_automation_bindings` (
	`pane_id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`session_kind` text DEFAULT 'todo-agent' NOT NULL,
	`connected_at` integer NOT NULL
);
