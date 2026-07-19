ALTER TABLE `products` ADD `category_status` text DEFAULT 'needs_review' NOT NULL;--> statement-breakpoint
ALTER TABLE `products` ADD `category_reviewed_at` text;--> statement-breakpoint
ALTER TABLE `products` ADD `category_reviewed_by_member_id` text REFERENCES household_members(id) ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE `products` ADD `catalog_revision` text;--> statement-breakpoint
CREATE INDEX `products_household_category_status_idx` ON `products` (`household_id`,`category_status`);
