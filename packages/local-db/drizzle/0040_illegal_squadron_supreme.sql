CREATE TABLE `browser_site_permissions` (
	`id` text PRIMARY KEY NOT NULL,
	`origin` text NOT NULL,
	`kind` text NOT NULL,
	`value` text DEFAULT 'ask' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `browser_site_permissions_origin_idx` ON `browser_site_permissions` (`origin`);--> statement-breakpoint
CREATE UNIQUE INDEX `browser_site_permissions_origin_kind_unique` ON `browser_site_permissions` (`origin`,`kind`);