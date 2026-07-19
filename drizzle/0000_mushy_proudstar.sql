CREATE TABLE `feedback` (
	`id` text PRIMARY KEY NOT NULL,
	`household_id` text NOT NULL,
	`trip_id` text,
	`receipt_transaction_id` text,
	`list_item_id` text,
	`receipt_item_id` text,
	`kind` text NOT NULL,
	`value` text NOT NULL,
	`rating` integer,
	`note` text,
	`created_by_member_id` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`trip_id`) REFERENCES `trips`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`receipt_transaction_id`) REFERENCES `receipt_transactions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`list_item_id`) REFERENCES `trip_list_items`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`receipt_item_id`) REFERENCES `receipt_items`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`created_by_member_id`) REFERENCES `household_members`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `feedback_household_created_idx` ON `feedback` (`household_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `feedback_trip_idx` ON `feedback` (`trip_id`);--> statement-breakpoint
CREATE INDEX `feedback_receipt_transaction_idx` ON `feedback` (`receipt_transaction_id`);--> statement-breakpoint
CREATE INDEX `feedback_receipt_item_idx` ON `feedback` (`receipt_item_id`);--> statement-breakpoint
CREATE TABLE `household_members` (
	`id` text PRIMARY KEY NOT NULL,
	`household_id` text NOT NULL,
	`user_email` text NOT NULL,
	`display_name` text NOT NULL,
	`role` text DEFAULT 'member' NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`last_seen_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `household_members_household_email_unique` ON `household_members` (`household_id`,`user_email`);--> statement-breakpoint
CREATE INDEX `household_members_household_idx` ON `household_members` (`household_id`);--> statement-breakpoint
CREATE TABLE `households` (
	`id` text PRIMARY KEY NOT NULL,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	`time_zone` text DEFAULT 'America/Los_Angeles' NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `households_slug_unique` ON `households` (`slug`);--> statement-breakpoint
CREATE TABLE `products` (
	`id` text PRIMARY KEY NOT NULL,
	`household_id` text NOT NULL,
	`costco_item_number` text,
	`canonical_name` text NOT NULL,
	`category` text,
	`brand` text,
	`unit_description` text,
	`active` integer DEFAULT true NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `products_household_item_number_unique` ON `products` (`household_id`,`costco_item_number`);--> statement-breakpoint
CREATE INDEX `products_household_name_idx` ON `products` (`household_id`,`canonical_name`);--> statement-breakpoint
CREATE TABLE `receipt_items` (
	`id` text PRIMARY KEY NOT NULL,
	`receipt_transaction_id` text NOT NULL,
	`product_id` text,
	`source_line_number` integer NOT NULL,
	`costco_item_number` text,
	`raw_description` text NOT NULL,
	`quantity_milli` integer DEFAULT 1000 NOT NULL,
	`unit_price_cents` integer,
	`unit_price_mills` integer,
	`line_subtotal_cents` integer NOT NULL,
	`discount_cents` integer DEFAULT 0 NOT NULL,
	`net_amount_cents` integer NOT NULL,
	`tax_status` text NOT NULL,
	`normalization_status` text NOT NULL,
	`is_return` integer DEFAULT false NOT NULL,
	`match_confidence_bps` integer,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`receipt_transaction_id`) REFERENCES `receipt_transactions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `receipt_items_transaction_line_unique` ON `receipt_items` (`receipt_transaction_id`,`source_line_number`);--> statement-breakpoint
CREATE INDEX `receipt_items_product_idx` ON `receipt_items` (`product_id`);--> statement-breakpoint
CREATE TABLE `receipt_transactions` (
	`id` text PRIMARY KEY NOT NULL,
	`household_id` text NOT NULL,
	`trip_id` text,
	`source_transaction_key` text NOT NULL,
	`transaction_type` text DEFAULT 'warehouse' NOT NULL,
	`source_type` text NOT NULL,
	`purchased_at` text NOT NULL,
	`item_gross_cents` integer NOT NULL,
	`item_count` integer NOT NULL,
	`subtotal_cents` integer NOT NULL,
	`tax_cents` integer DEFAULT 0 NOT NULL,
	`discount_cents` integer DEFAULT 0 NOT NULL,
	`total_cents` integer NOT NULL,
	`household_funded_cents` integer NOT NULL,
	`external_funding_cents` integer DEFAULT 0 NOT NULL,
	`audit_flag` text DEFAULT 'none' NOT NULL,
	`parse_status` text DEFAULT 'needs_review' NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`trip_id`) REFERENCES `trips`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `receipt_transactions_household_source_key_unique` ON `receipt_transactions` (`household_id`,`source_transaction_key`);--> statement-breakpoint
CREATE INDEX `receipt_transactions_household_purchased_idx` ON `receipt_transactions` (`household_id`,`purchased_at`);--> statement-breakpoint
CREATE INDEX `receipt_transactions_trip_idx` ON `receipt_transactions` (`trip_id`);--> statement-breakpoint
CREATE TABLE `trip_list_items` (
	`id` text PRIMARY KEY NOT NULL,
	`trip_id` text NOT NULL,
	`product_id` text,
	`label` text NOT NULL,
	`section` text DEFAULT 'essentials' NOT NULL,
	`source` text DEFAULT 'manual' NOT NULL,
	`recommendation_reason` text,
	`confidence_bps` integer,
	`included` integer DEFAULT true NOT NULL,
	`checked` integer DEFAULT false NOT NULL,
	`included_at_freeze` integer,
	`added_after_freeze` integer DEFAULT false NOT NULL,
	`estimated_price_cents` integer,
	`quantity_milli` integer DEFAULT 1000 NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`added_by_member_id` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`trip_id`) REFERENCES `trips`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`added_by_member_id`) REFERENCES `household_members`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `trip_list_items_trip_sort_idx` ON `trip_list_items` (`trip_id`,`sort_order`);--> statement-breakpoint
CREATE INDEX `trip_list_items_product_idx` ON `trip_list_items` (`product_id`);--> statement-breakpoint
CREATE TABLE `trips` (
	`id` text PRIMARY KEY NOT NULL,
	`household_id` text NOT NULL,
	`scheduled_for` text NOT NULL,
	`status` text DEFAULT 'planning' NOT NULL,
	`target_cents` integer,
	`discovery_allowance_cents` integer,
	`frozen_at` text,
	`completed_at` text,
	`created_by_member_id` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by_member_id`) REFERENCES `household_members`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `trips_household_scheduled_for_unique` ON `trips` (`household_id`,`scheduled_for`);--> statement-breakpoint
CREATE INDEX `trips_household_status_idx` ON `trips` (`household_id`,`status`);