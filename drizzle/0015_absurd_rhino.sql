CREATE TABLE `recommendation_shadow_candidates` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`product_id` text NOT NULL,
	`rank` integer,
	`score_bps` integer NOT NULL,
	`eligible` integer NOT NULL,
	`selected` integer NOT NULL,
	`product_state` text NOT NULL,
	`reason` text NOT NULL,
	`components_json` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `recommendation_shadow_runs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `recommendation_shadow_candidates_run_product_unique` ON `recommendation_shadow_candidates` (`run_id`,`product_id`);--> statement-breakpoint
CREATE INDEX `recommendation_shadow_candidates_run_rank_idx` ON `recommendation_shadow_candidates` (`run_id`,`rank`);--> statement-breakpoint
CREATE TABLE `recommendation_shadow_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`household_id` text NOT NULL,
	`as_of_date` text NOT NULL,
	`engine_version` text NOT NULL,
	`mode` text NOT NULL,
	`attention_budget` integer NOT NULL,
	`catalog_size` integer NOT NULL,
	`eligible_count` integer NOT NULL,
	`metrics_json` text NOT NULL,
	`created_by_member_id` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`household_id`) REFERENCES `households`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by_member_id`) REFERENCES `household_members`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `recommendation_shadow_runs_household_cycle_unique` ON `recommendation_shadow_runs` (`household_id`,`as_of_date`,`engine_version`,`mode`);--> statement-breakpoint
CREATE INDEX `recommendation_shadow_runs_household_created_idx` ON `recommendation_shadow_runs` (`household_id`,`created_at`);