ALTER TABLE `todo_sessions` ADD `claude_session_id` text;--> statement-breakpoint
ALTER TABLE `todo_sessions` ADD `final_assistant_text` text;--> statement-breakpoint
ALTER TABLE `todo_sessions` ADD `total_cost_usd` real;--> statement-breakpoint
ALTER TABLE `todo_sessions` ADD `total_num_turns` integer;--> statement-breakpoint
ALTER TABLE `todo_sessions` ADD `pending_intervention` text;