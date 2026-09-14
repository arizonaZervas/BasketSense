/** SQL fragments use only source-owned aliases, never user input. */
export function householdKnowledgeProtectedSql(product = "products") {
  if (!["products", "p"].includes(product)) throw new Error("Invalid product SQL alias");
  return `(${product}.category_reviewed_by_member_id IS NOT NULL
    OR EXISTS (SELECT 1 FROM product_aliases AS confirmed_alias
      WHERE confirmed_alias.household_id = ${product}.household_id
        AND confirmed_alias.product_id = ${product}.id
        AND confirmed_alias.confirmed_by_member_id IS NOT NULL)
    OR EXISTS (SELECT 1 FROM intent_fulfillments AS confirmed_intent
      WHERE confirmed_intent.household_id = ${product}.household_id
        AND confirmed_intent.costco_item_number = ${product}.costco_item_number
        AND confirmed_intent.confirmed_by_member_id IS NOT NULL))`;
}

// Until audited promotion exists, household-confirmed products use catalog and
// explicit feedback, not an older model profile that could contradict them.
export function usableModelKnowledgeSql(knowledge = "product_understandings") {
  if (!["product_understandings", "knowledge"].includes(knowledge)) throw new Error("Invalid knowledge SQL alias");
  return `NOT EXISTS (SELECT 1 FROM products AS p
    WHERE p.household_id = ${knowledge}.household_id
      AND p.costco_item_number = ${knowledge}.costco_item_number
      AND ${householdKnowledgeProtectedSql("p")})`;
}
