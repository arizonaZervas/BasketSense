CREATE TABLE `product_images` (
	`id` text PRIMARY KEY NOT NULL,
	`household_id` text NOT NULL,
	`product_id` text NOT NULL,
	`source_type` text NOT NULL,
	`source_page_url` text,
	`source_image_url` text,
	`source_external_id` text,
	`source_product_name` text,
	`source_brand` text,
	`source_quantity` text,
	`storage_key` text,
	`attribution_text` text,
	`license_code` text,
	`confidence_bps` integer,
	`status` text DEFAULT 'candidate' NOT NULL,
	`is_primary` integer DEFAULT false NOT NULL,
	`width_px` integer,
	`height_px` integer,
	`content_type` text,
	`byte_size` integer,
	`content_sha256` text,
	`created_by_member_id` text,
	`reviewed_by_member_id` text,
	`reviewed_at` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by_member_id`) REFERENCES `household_members`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`reviewed_by_member_id`) REFERENCES `household_members`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `product_images_product_source_unique` ON `product_images` (`product_id`,`source_image_url`);--> statement-breakpoint
CREATE UNIQUE INDEX `product_images_storage_key_unique` ON `product_images` (`storage_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `product_images_product_primary_unique` ON `product_images` (`product_id`) WHERE is_primary = 1 AND status = 'approved';--> statement-breakpoint
CREATE INDEX `product_images_household_status_idx` ON `product_images` (`household_id`,`status`,`updated_at`);--> statement-breakpoint
CREATE INDEX `product_images_product_status_idx` ON `product_images` (`product_id`,`status`,`is_primary`);