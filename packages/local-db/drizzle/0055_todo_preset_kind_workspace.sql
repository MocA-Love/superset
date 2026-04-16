ALTER TABLE `todo_prompt_presets` ADD `kind` text DEFAULT 'system' NOT NULL;--> statement-breakpoint
ALTER TABLE `todo_prompt_presets` ADD `workspace_id` text;--> statement-breakpoint
CREATE INDEX `todo_prompt_presets_kind_idx` ON `todo_prompt_presets` (`kind`);--> statement-breakpoint
CREATE INDEX `todo_prompt_presets_workspace_idx` ON `todo_prompt_presets` (`workspace_id`);