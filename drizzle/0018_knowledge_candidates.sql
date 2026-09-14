CREATE TABLE IF NOT EXISTS `product_understanding_candidates` (
	`household_id` text NOT NULL,
	`lookup_key` text NOT NULL,
	`model` text NOT NULL,
	`prompt_version` text NOT NULL,
	`schema_version` text NOT NULL,
	`proposal_json` text NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`household_id`, `lookup_key`, `prompt_version`, `schema_version`),
	FOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE cascade
);
