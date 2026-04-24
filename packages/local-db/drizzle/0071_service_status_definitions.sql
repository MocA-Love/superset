CREATE TABLE `service_status_definitions` (
	`id` text PRIMARY KEY NOT NULL,
	`label` text NOT NULL,
	`status_url` text NOT NULL,
	`api_url` text NOT NULL,
	`icon_type` text DEFAULT 'favicon' NOT NULL,
	`icon_value` text,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `service_status_definitions_sort_order_idx` ON `service_status_definitions` (`sort_order`);--> statement-breakpoint
ALTER TABLE `settings` ADD `service_status_defaults_seeded` integer;