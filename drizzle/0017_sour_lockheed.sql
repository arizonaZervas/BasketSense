ALTER TABLE `product_understandings` ADD `intent_aliases_json` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
INSERT INTO product_understandings (
  id, household_id, lookup_key, costco_item_number, raw_description,
  canonical_name, brand, product_family, variant, category_hint,
  confidence_bps, exact_sku_known, search_aliases_json, intent_aliases_json,
  provider, model, prompt_version, schema_version, created_at, updated_at
)
SELECT
  'verified-intent:' || receipt_transactions.household_id || ':5161251',
  receipt_transactions.household_id,
  'item:5161251',
  '5161251',
  MAX(receipt_items.raw_description),
  'Downy Unstopables Fresh In-Wash Scent Booster Beads',
  'Downy',
  'Laundry scent booster beads',
  'Fresh',
  'household_supplies',
  10000,
  1,
  '["Downy Fresh","Downy Unstopables Fresh"]',
  '["laundry scent booster","scent booster beads"]',
  'verified_seed',
  'verified-household-correction',
  'costco-line-understanding-v2',
  'basketsense-product-understanding-v2',
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM receipt_items
INNER JOIN receipt_transactions
  ON receipt_transactions.id = receipt_items.receipt_transaction_id
WHERE receipt_items.costco_item_number = '5161251'
GROUP BY receipt_transactions.household_id
ON CONFLICT(household_id, lookup_key) DO UPDATE SET
  raw_description = excluded.raw_description,
  canonical_name = excluded.canonical_name,
  brand = excluded.brand,
  product_family = excluded.product_family,
  variant = excluded.variant,
  category_hint = excluded.category_hint,
  confidence_bps = excluded.confidence_bps,
  exact_sku_known = excluded.exact_sku_known,
  search_aliases_json = excluded.search_aliases_json,
  intent_aliases_json = excluded.intent_aliases_json,
  provider = excluded.provider,
  model = excluded.model,
  prompt_version = excluded.prompt_version,
  schema_version = excluded.schema_version,
  updated_at = excluded.updated_at;--> statement-breakpoint
INSERT INTO product_understandings (
  id, household_id, lookup_key, costco_item_number, raw_description,
  canonical_name, brand, product_family, variant, category_hint,
  confidence_bps, exact_sku_known, search_aliases_json, intent_aliases_json,
  provider, model, prompt_version, schema_version, created_at, updated_at
)
SELECT
  'verified-intent:' || receipt_transactions.household_id || ':1860779',
  receipt_transactions.household_id,
  'item:1860779',
  '1860779',
  MAX(receipt_items.raw_description),
  'Naked White Bread',
  'Naked Bread',
  'Bread',
  'White',
  'groceries_beverages',
  10000,
  1,
  '["Naked White","white sandwich bread"]',
  '["bread","white bread"]',
  'verified_seed',
  'verified-household-correction',
  'costco-line-understanding-v2',
  'basketsense-product-understanding-v2',
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM receipt_items
INNER JOIN receipt_transactions
  ON receipt_transactions.id = receipt_items.receipt_transaction_id
WHERE receipt_items.costco_item_number = '1860779'
GROUP BY receipt_transactions.household_id
ON CONFLICT(household_id, lookup_key) DO UPDATE SET
  raw_description = excluded.raw_description,
  canonical_name = excluded.canonical_name,
  brand = excluded.brand,
  product_family = excluded.product_family,
  variant = excluded.variant,
  category_hint = excluded.category_hint,
  confidence_bps = excluded.confidence_bps,
  exact_sku_known = excluded.exact_sku_known,
  search_aliases_json = excluded.search_aliases_json,
  intent_aliases_json = excluded.intent_aliases_json,
  provider = excluded.provider,
  model = excluded.model,
  prompt_version = excluded.prompt_version,
  schema_version = excluded.schema_version,
  updated_at = excluded.updated_at;
