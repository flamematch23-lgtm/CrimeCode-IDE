-- Multi-tenant scoping foundation. Adds customer_id to the two root entities
-- (project and session). NULL = legacy / shared visibility — keeps existing
-- rows readable by every authenticated caller during the transition. New rows
-- created by Bearer-authenticated callers should be tagged with the caller's
-- customer_id so future queries can filter cleanly.
--
-- Indexes are deliberate: filtered listings on the central API server are the
-- hot path (web app: "show me my projects / my sessions"), so we want SQLite
-- to use the index for both customer_id IS NULL and customer_id = ? lookups.

ALTER TABLE `project` ADD COLUMN `customer_id` text;
--> statement-breakpoint
CREATE INDEX `project_customer_idx` ON `project` (`customer_id`);
--> statement-breakpoint
ALTER TABLE `session` ADD COLUMN `customer_id` text;
--> statement-breakpoint
CREATE INDEX `session_customer_idx` ON `session` (`customer_id`);
