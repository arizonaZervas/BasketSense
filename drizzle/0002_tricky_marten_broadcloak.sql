CREATE TABLE `product_aliases` (
	`id` text PRIMARY KEY NOT NULL,
	`household_id` text NOT NULL,
	`alias_key` text NOT NULL,
	`raw_description` text NOT NULL,
	`normalized_description` text NOT NULL,
	`costco_item_number` text,
	`product_id` text NOT NULL,
	`confirmation_source` text NOT NULL,
	`confirmed_by_member_id` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`confirmed_by_member_id`) REFERENCES `household_members`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `product_aliases_household_key_unique` ON `product_aliases` (`household_id`,`alias_key`);--> statement-breakpoint
CREATE INDEX `product_aliases_product_idx` ON `product_aliases` (`product_id`);--> statement-breakpoint
CREATE TABLE `receipt_uploads` (
	`id` text PRIMARY KEY NOT NULL,
	`household_id` text NOT NULL,
	`receipt_transaction_id` text NOT NULL,
	`storage_key` text NOT NULL,
	`original_filename` text NOT NULL,
	`content_type` text NOT NULL,
	`byte_size` integer NOT NULL,
	`status` text DEFAULT 'stored' NOT NULL,
	`uploaded_by_member_id` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`receipt_transaction_id`) REFERENCES `receipt_transactions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`uploaded_by_member_id`) REFERENCES `household_members`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `receipt_uploads_receipt_unique` ON `receipt_uploads` (`receipt_transaction_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `receipt_uploads_storage_key_unique` ON `receipt_uploads` (`storage_key`);--> statement-breakpoint
CREATE INDEX `receipt_uploads_household_idx` ON `receipt_uploads` (`household_id`);--> statement-breakpoint
CREATE TABLE `review_questions` (
	`id` text PRIMARY KEY NOT NULL,
	`household_id` text NOT NULL,
	`trip_id` text NOT NULL,
	`receipt_transaction_id` text NOT NULL,
	`question_key` text NOT NULL,
	`purpose` text NOT NULL,
	`prompt` text NOT NULL,
	`options_json` text NOT NULL,
	`declared_effect` text NOT NULL,
	`effect_target` text,
	`list_item_id` text,
	`intent_item_id` text,
	`receipt_item_id` text,
	`priority` integer DEFAULT 100 NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`answer_value` text,
	`answer_note` text,
	`answered_by_member_id` text,
	`answered_at` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`trip_id`) REFERENCES `trips`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`receipt_transaction_id`) REFERENCES `receipt_transactions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`list_item_id`) REFERENCES `trip_list_items`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`intent_item_id`) REFERENCES `trip_intent_items`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`receipt_item_id`) REFERENCES `receipt_items`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`answered_by_member_id`) REFERENCES `household_members`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `review_questions_receipt_key_unique` ON `review_questions` (`receipt_transaction_id`,`question_key`);--> statement-breakpoint
CREATE INDEX `review_questions_receipt_status_idx` ON `review_questions` (`receipt_transaction_id`,`status`,`priority`);--> statement-breakpoint
CREATE INDEX `review_questions_household_idx` ON `review_questions` (`household_id`);--> statement-breakpoint
CREATE TABLE `trip_intent_items` (
	`id` text PRIMARY KEY NOT NULL,
	`snapshot_id` text NOT NULL,
	`trip_id` text NOT NULL,
	`list_item_id` text,
	`product_id` text,
	`label` text NOT NULL,
	`section` text NOT NULL,
	`source` text NOT NULL,
	`recommendation_reason` text,
	`confidence_bps` integer,
	`included` integer NOT NULL,
	`quantity_milli` integer DEFAULT 1000 NOT NULL,
	`estimated_price_cents` integer,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`snapshot_id`) REFERENCES `trip_intent_snapshots`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`trip_id`) REFERENCES `trips`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`list_item_id`) REFERENCES `trip_list_items`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `trip_intent_items_snapshot_list_unique` ON `trip_intent_items` (`snapshot_id`,`list_item_id`);--> statement-breakpoint
CREATE INDEX `trip_intent_items_trip_sort_idx` ON `trip_intent_items` (`trip_id`,`sort_order`);--> statement-breakpoint
CREATE INDEX `trip_intent_items_product_idx` ON `trip_intent_items` (`product_id`);--> statement-breakpoint
CREATE TABLE `trip_intent_snapshots` (
	`id` text PRIMARY KEY NOT NULL,
	`trip_id` text NOT NULL,
	`evidence_level` text NOT NULL,
	`estimated_total_cents` integer DEFAULT 0 NOT NULL,
	`priced_item_count` integer DEFAULT 0 NOT NULL,
	`unpriced_item_count` integer DEFAULT 0 NOT NULL,
	`captured_by_member_id` text,
	`captured_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`trip_id`) REFERENCES `trips`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`captured_by_member_id`) REFERENCES `household_members`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `trip_intent_snapshots_trip_unique` ON `trip_intent_snapshots` (`trip_id`);--> statement-breakpoint
CREATE INDEX `trip_intent_snapshots_evidence_idx` ON `trip_intent_snapshots` (`evidence_level`);--> statement-breakpoint
CREATE TABLE `trip_item_matches` (
	`id` text PRIMARY KEY NOT NULL,
	`household_id` text NOT NULL,
	`trip_id` text NOT NULL,
	`receipt_transaction_id` text NOT NULL,
	`intent_item_id` text NOT NULL,
	`receipt_item_id` text NOT NULL,
	`match_type` text NOT NULL,
	`confidence_bps` integer NOT NULL,
	`resolution_source` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`trip_id`) REFERENCES `trips`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`receipt_transaction_id`) REFERENCES `receipt_transactions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`intent_item_id`) REFERENCES `trip_intent_items`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`receipt_item_id`) REFERENCES `receipt_items`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `trip_item_matches_receipt_item_unique` ON `trip_item_matches` (`receipt_item_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `trip_item_matches_intent_item_unique` ON `trip_item_matches` (`intent_item_id`);--> statement-breakpoint
CREATE INDEX `trip_item_matches_receipt_idx` ON `trip_item_matches` (`receipt_transaction_id`);--> statement-breakpoint
CREATE INDEX `trip_item_matches_trip_idx` ON `trip_item_matches` (`trip_id`);