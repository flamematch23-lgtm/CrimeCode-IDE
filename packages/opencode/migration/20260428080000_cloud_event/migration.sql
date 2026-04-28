CREATE TABLE `cloud_event` (
	`customer_id` text NOT NULL,
	`aggregate_id` text NOT NULL,
	`seq` integer NOT NULL,
	`id` text NOT NULL,
	`type` text NOT NULL,
	`data` text NOT NULL,
	`pushed_at` integer NOT NULL,
	PRIMARY KEY(`customer_id`, `aggregate_id`, `seq`)
);
--> statement-breakpoint
CREATE INDEX `cloud_event_customer_pushed_idx` ON `cloud_event` (`customer_id`,`pushed_at`);
--> statement-breakpoint
CREATE TABLE `sync_cursor` (
	`key` text PRIMARY KEY,
	`value` text NOT NULL
);
