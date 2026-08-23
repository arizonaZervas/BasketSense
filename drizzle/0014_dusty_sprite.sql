CREATE TABLE `intent_fulfillments` (
	`id` text PRIMARY KEY NOT NULL,
	`household_id` text NOT NULL,
	`intent_key` text NOT NULL,
	`receipt_key` text NOT NULL,
	`raw_intent_label` text NOT NULL,
	`raw_receipt_description` text NOT NULL,
	`costco_item_number` text,
	`relation` text NOT NULL,
	`confidence_bps` integer DEFAULT 10000 NOT NULL,
	`confirmed_by_member_id` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`confirmed_by_member_id`) REFERENCES `household_members`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `intent_fulfillments_household_pair_unique` ON `intent_fulfillments` (`household_id`,`intent_key`,`receipt_key`);--> statement-breakpoint
CREATE INDEX `intent_fulfillments_household_intent_idx` ON `intent_fulfillments` (`household_id`,`intent_key`);--> statement-breakpoint
CREATE TABLE `product_understandings` (
	`id` text PRIMARY KEY NOT NULL,
	`household_id` text NOT NULL,
	`lookup_key` text NOT NULL,
	`costco_item_number` text,
	`raw_description` text NOT NULL,
	`canonical_name` text NOT NULL,
	`brand` text,
	`product_family` text,
	`variant` text,
	`category_hint` text,
	`confidence_bps` integer NOT NULL,
	`exact_sku_known` integer DEFAULT false NOT NULL,
	`search_aliases_json` text DEFAULT '[]' NOT NULL,
	`provider` text NOT NULL,
	`model` text NOT NULL,
	`prompt_version` text NOT NULL,
	`schema_version` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `product_understandings_household_lookup_unique` ON `product_understandings` (`household_id`,`lookup_key`);--> statement-breakpoint
CREATE INDEX `product_understandings_item_number_idx` ON `product_understandings` (`household_id`,`costco_item_number`);--> statement-breakpoint
ALTER TABLE `receipt_items` ADD `interpreted_name` text;--> statement-breakpoint
ALTER TABLE `receipt_items` ADD `interpreted_brand` text;--> statement-breakpoint
ALTER TABLE `receipt_items` ADD `interpreted_product_family` text;--> statement-breakpoint
ALTER TABLE `receipt_items` ADD `interpreted_variant` text;--> statement-breakpoint
ALTER TABLE `receipt_items` ADD `interpretation_category_hint` text;--> statement-breakpoint
ALTER TABLE `receipt_items` ADD `interpretation_confidence_bps` integer;--> statement-breakpoint
ALTER TABLE `receipt_items` ADD `interpretation_source` text;--> statement-breakpoint
ALTER TABLE `receipt_items` ADD `interpretation_model` text;