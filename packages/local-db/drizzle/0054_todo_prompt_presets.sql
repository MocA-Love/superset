CREATE TABLE `todo_prompt_presets` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`content` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `todo_prompt_presets_name_idx` ON `todo_prompt_presets` (`name`);--> statement-breakpoint
CREATE INDEX `todo_prompt_presets_updated_at_idx` ON `todo_prompt_presets` (`updated_at`);--> statement-breakpoint
ALTER TABLE `todo_sessions` ADD `custom_system_prompt` text;