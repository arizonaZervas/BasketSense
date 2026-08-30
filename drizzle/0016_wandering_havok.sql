CREATE TABLE `trip_skips` (
	`id` text PRIMARY KEY NOT NULL,
	`household_id` text NOT NULL,
	`trip_id` text NOT NULL,
	`scheduled_for` text NOT NULL,
	`skipped_by_member_id` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`trip_id`) REFERENCES `trips`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`skipped_by_member_id`) REFERENCES `household_members`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `trip_skips_household_scheduled_for_unique` ON `trip_skips` (`household_id`,`scheduled_for`);--> statement-breakpoint
CREATE INDEX `trip_skips_trip_scheduled_for_idx` ON `trip_skips` (`trip_id`,`scheduled_for`);