CREATE TABLE `product_image_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`household_id` text NOT NULL,
	`product_id` text NOT NULL,
	`receipt_transaction_id` text,
	`status` text DEFAULT 'queued' NOT NULL,
	`attempt_count` integer DEFAULT 0 NOT NULL,
	`model` text,
	`error_code` text,
	`locked_at` text,
	`completed_at` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`receipt_transaction_id`) REFERENCES `receipt_transactions`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `product_image_jobs_product_unique` ON `product_image_jobs` (`product_id`);--> statement-breakpoint
CREATE INDEX `product_image_jobs_status_idx` ON `product_image_jobs` (`status`,`updated_at`);--> statement-breakpoint
CREATE INDEX `product_image_jobs_household_status_idx` ON `product_image_jobs` (`household_id`,`status`,`updated_at`);--> statement-breakpoint
CREATE INDEX `product_image_jobs_receipt_idx` ON `product_image_jobs` (`receipt_transaction_id`);