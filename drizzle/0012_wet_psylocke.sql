ALTER TABLE `feedback` ADD `product_id` text REFERENCES products(id);--> statement-breakpoint
UPDATE `feedback`
SET `product_id` = (
	SELECT `receipt_items`.`product_id`
	FROM `receipt_items`
	WHERE `receipt_items`.`id` = `feedback`.`receipt_item_id`
	LIMIT 1
)
WHERE `kind` = 'product_experience'
	AND `product_id` IS NULL;--> statement-breakpoint
CREATE INDEX `feedback_product_idx` ON `feedback` (`product_id`);
