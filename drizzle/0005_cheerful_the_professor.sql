CREATE TABLE `email_outbox` (
	`id` text PRIMARY KEY NOT NULL,
	`household_id` text NOT NULL,
	`trip_id` text NOT NULL,
	`recipient_member_id` text NOT NULL,
	`kind` text DEFAULT 'trip_summary' NOT NULL,
	`dedupe_key` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`attempt_count` integer DEFAULT 0 NOT NULL,
	`provider_message_id` text,
	`last_error_code` text,
	`locked_at` text,
	`sent_at` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`trip_id`) REFERENCES `trips`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`recipient_member_id`) REFERENCES `household_members`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `email_outbox_dedupe_key_unique` ON `email_outbox` (`dedupe_key`);--> statement-breakpoint
CREATE INDEX `email_outbox_household_status_idx` ON `email_outbox` (`household_id`,`status`,`updated_at`);--> statement-breakpoint
CREATE INDEX `email_outbox_trip_idx` ON `email_outbox` (`trip_id`);--> statement-breakpoint
CREATE INDEX `email_outbox_recipient_idx` ON `email_outbox` (`recipient_member_id`);