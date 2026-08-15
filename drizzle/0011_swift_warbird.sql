CREATE TABLE `receipt_corrections` (
	`id` text PRIMARY KEY NOT NULL,
	`household_id` text NOT NULL,
	`trip_id` text NOT NULL,
	`receipt_transaction_id` text NOT NULL,
	`ingestion_id` text NOT NULL,
	`revision` integer NOT NULL,
	`status` text DEFAULT 'applied' NOT NULL,
	`previous_receipt_json` text NOT NULL,
	`previous_items_json` text NOT NULL,
	`previous_matches_json` text NOT NULL,
	`previous_questions_json` text NOT NULL,
	`previous_upload_json` text,
	`replacement_storage_key` text NOT NULL,
	`applied_by_member_id` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`applied_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`trip_id`) REFERENCES `trips`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`receipt_transaction_id`) REFERENCES `receipt_transactions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`ingestion_id`) REFERENCES `receipt_ingestions`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`applied_by_member_id`) REFERENCES `household_members`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `receipt_corrections_ingestion_unique` ON `receipt_corrections` (`ingestion_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `receipt_corrections_receipt_revision_unique` ON `receipt_corrections` (`receipt_transaction_id`,`revision`);--> statement-breakpoint
CREATE INDEX `receipt_corrections_receipt_idx` ON `receipt_corrections` (`receipt_transaction_id`,`applied_at`);--> statement-breakpoint
CREATE INDEX `receipt_corrections_household_idx` ON `receipt_corrections` (`household_id`,`applied_at`);--> statement-breakpoint
ALTER TABLE `receipt_ingestions` ADD `recovery_manifest_key` text;--> statement-breakpoint
ALTER TABLE `receipt_ingestions` ADD `provider_response_id` text;--> statement-breakpoint
ALTER TABLE `receipt_ingestions` ADD `provider_finish_reason` text;--> statement-breakpoint
ALTER TABLE `receipt_ingestions` ADD `provider_duration_ms` integer;--> statement-breakpoint
ALTER TABLE `receipt_ingestions` ADD `extraction_pass` integer;