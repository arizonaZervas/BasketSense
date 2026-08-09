ALTER TABLE `trip_list_items` ADD `list_revision` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `trips` ADD `list_revision` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE TRIGGER `trip_list_items_revision_after_insert`
AFTER INSERT ON `trip_list_items`
BEGIN
  UPDATE `trips`
  SET `list_revision` = `list_revision` + 1
  WHERE `id` = NEW.`trip_id`;
  UPDATE `trip_list_items`
  SET `list_revision` = (
    SELECT `list_revision` FROM `trips` WHERE `id` = NEW.`trip_id`
  )
  WHERE `id` = NEW.`id`;
END;--> statement-breakpoint
CREATE TRIGGER `trip_list_items_revision_after_update`
AFTER UPDATE OF
  `product_id`, `label`, `section`, `source`, `recommendation_reason`,
  `confidence_bps`, `included`, `checked`, `included_at_freeze`,
  `added_after_freeze`, `estimated_price_cents`, `quantity_milli`,
  `sort_order`, `added_by_member_id`
ON `trip_list_items`
BEGIN
  UPDATE `trips`
  SET `list_revision` = `list_revision` + 1
  WHERE `id` = NEW.`trip_id`;
  UPDATE `trip_list_items`
  SET `list_revision` = (
    SELECT `list_revision` FROM `trips` WHERE `id` = NEW.`trip_id`
  )
  WHERE `id` = NEW.`id`;
END;--> statement-breakpoint
CREATE TRIGGER `trip_list_items_revision_after_delete`
AFTER DELETE ON `trip_list_items`
BEGIN
  UPDATE `trips`
  SET `list_revision` = `list_revision` + 1
  WHERE `id` = OLD.`trip_id`;
END;--> statement-breakpoint
CREATE TRIGGER `trips_list_revision_after_state_update`
AFTER UPDATE OF
  `status`, `target_cents`, `discovery_allowance_cents`,
  `estimated_list_total_at_freeze_cents`,
  `estimated_priced_item_count_at_freeze`,
  `estimated_unpriced_item_count_at_freeze`,
  `frozen_at`, `completed_at`
ON `trips`
BEGIN
  UPDATE `trips`
  SET `list_revision` = `list_revision` + 1
  WHERE `id` = NEW.`id`;
END;
