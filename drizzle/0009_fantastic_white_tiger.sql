PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_receipt_ingestions` (
	`id` text PRIMARY KEY NOT NULL,
	`household_id` text NOT NULL,
	`trip_id` text,
	`requested_by_member_id` text,
	`client_request_id` text NOT NULL,
	`source_storage_key` text NOT NULL,
	`source_sha256` text,
	`source_content_type` text NOT NULL,
	`source_byte_size` integer NOT NULL,
	`status` text DEFAULT 'uploaded' NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`attempt_count` integer DEFAULT 0 NOT NULL,
	`workflow_instance_id` text,
	`provider` text,
	`model` text,
	`prompt_version` text,
	`schema_version` text,
	`extraction_artifact_key` text,
	`receipt_transaction_id` text,
	`error_code` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`completed_at` text,
	FOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`trip_id`) REFERENCES `trips`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`requested_by_member_id`) REFERENCES `household_members`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`receipt_transaction_id`) REFERENCES `receipt_transactions`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
INSERT INTO `__new_receipt_ingestions`("id", "household_id", "trip_id", "requested_by_member_id", "client_request_id", "source_storage_key", "source_sha256", "source_content_type", "source_byte_size", "status", "revision", "attempt_count", "workflow_instance_id", "provider", "model", "prompt_version", "schema_version", "extraction_artifact_key", "receipt_transaction_id", "error_code", "created_at", "updated_at", "completed_at") SELECT "id", "household_id", "trip_id", "requested_by_member_id", "client_request_id", "source_storage_key", "source_sha256", "source_content_type", "source_byte_size", "status", "revision", "attempt_count", "workflow_instance_id", "provider", "model", "prompt_version", "schema_version", "extraction_artifact_key", "receipt_transaction_id", "error_code", "created_at", "updated_at", "completed_at" FROM `receipt_ingestions`;--> statement-breakpoint
DROP TABLE `receipt_ingestions`;--> statement-breakpoint
ALTER TABLE `__new_receipt_ingestions` RENAME TO `receipt_ingestions`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `receipt_ingestions_household_client_request_unique` ON `receipt_ingestions` (`household_id`,`client_request_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `receipt_ingestions_source_storage_key_unique` ON `receipt_ingestions` (`source_storage_key`);--> statement-breakpoint
CREATE INDEX `receipt_ingestions_household_status_idx` ON `receipt_ingestions` (`household_id`,`status`,`updated_at`);--> statement-breakpoint
CREATE INDEX `receipt_ingestions_trip_idx` ON `receipt_ingestions` (`trip_id`);--> statement-breakpoint
CREATE INDEX `receipt_ingestions_receipt_idx` ON `receipt_ingestions` (`receipt_transaction_id`);