// Offline review policy only. Never promotes knowledge or edits household data.
export const EVIDENCE_POLICY_VERSION = "household-evidence-v2";
const norm = (s) => typeof s === "string" ? s.normalize("NFKD").replace(/\p{M}/gu, "")
  .toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim() : "";
const unique = (a) => [...new Set(a.filter(Boolean))].sort();

/** Keep source references, not member details; an alias alone is not a family taxonomy. */
export function collectProductEvidence(householdId, product, products, aliases, relations) {
  if (product.household_id !== householdId) throw new Error("Evidence household mismatch");
  const localProducts = products.filter(p => p.household_id === householdId && p.active === 1);
  const confirmations = aliases.filter(a => a.household_id === householdId &&
    a.product_id === product.id && a.confirmed_by_member_id && norm(a.raw_description))
    .map(a => ({ source: "product_aliases", sourceId: a.id, updatedAt: a.updated_at,
      relation: "same_product", label: a.raw_description }));
  const decisions = relations.filter(r => r.household_id === householdId &&
    r.confirmed_by_member_id && product.costco_item_number &&
    r.costco_item_number === product.costco_item_number &&
    r.receipt_key === `item:${product.costco_item_number}` && norm(r.raw_intent_label) &&
    ["same_product", "fulfills_intent", "substitute", "not_same"].includes(r.relation))
    .map(r => ({ source: "intent_fulfillments", sourceId: r.id, updatedAt: r.updated_at,
      relation: r.relation, label: r.raw_intent_label }));
  const metadata = product.category_reviewed_by_member_id && norm(product.canonical_name)
    ? [{ source: "products", sourceId: product.id, updatedAt: product.category_reviewed_at,
      relation: "same_product", label: product.canonical_name }] : [];
  const facts = [...metadata, ...confirmations, ...decisions].sort((a,b) =>
    `${a.source}:${a.sourceId}`.localeCompare(`${b.source}:${b.sourceId}`));
  const collisions = facts.filter(f => f.relation === "same_product").flatMap(f =>
    localProducts.filter(p => p.id !== product.id && p.costco_item_number !== product.costco_item_number &&
      norm(p.canonical_name) === norm(f.label)).map(p => ({ sourceId: f.sourceId, otherProductId: p.id })));
  return { householdId, productId: product.id, facts, collisions };
}

/** Field-level review, not approval: preserve useful supported terms while
 * exposing exactly which additions lack evidence. No implicit taxonomy learning. */
export function buildKnowledgeReviewPacket(evidence, proposal, householdId) {
  const assessment = assessKnowledgeProposal(evidence, proposal, householdId);
  const scopeValid = evidence.confirmedEvidence?.householdId === householdId &&
    evidence.confirmedEvidence?.productId === evidence.productId;
  const facts = scopeValid ? evidence.confirmedEvidence.facts : [];
  const fields = proposal ? [
    ["canonicalName", [proposal.canonicalName]],
    ["brand", [proposal.brand]], ["productFamily", [proposal.productFamily]],
    ["variant", [proposal.variant]], ["categoryHint", [proposal.categoryHint]],
    ["searchAliases", proposal.searchAliases ?? []],
    ["intentAliases", proposal.intentAliases ?? []],
  ] : [];
  const terms = fields.flatMap(([field, values]) => unique(values.filter(v => typeof v === "string" && norm(v))).map(term => {
    const matching = facts.filter(f => norm(f.label) === norm(term));
    const negative = matching.filter(f => f.relation === "not_same");
    const exact = matching.filter(f => f.relation === "same_product");
    const positive = matching.filter(f => ["same_product", "fulfills_intent", "substitute"].includes(f.relation));
    const supporting = field === "intentAliases" ? positive : ["canonicalName", "searchAliases"].includes(field) ? exact : [];
    // A name or alias does not independently verify brand, family, category or variant.
    const state = negative.length ? "blocked" : supporting.length ? "supported" : "needs_review";
    return { field, term, state,
      use: field === "intentAliases" ? "intent_only" : field === "searchAliases" ? "exact_alias" : "attribute",
      sources: [...supporting, ...negative].map(f => ({ reference: `${f.source}:${f.sourceId}`, updatedAt: f.updatedAt, relation: f.relation })),
    };
  }));
  return { householdId, productId: evidence.productId, assessment, terms,
    counts: Object.fromEntries(["supported", "needs_review", "blocked"].map(state => [state, terms.filter(t => t.state === state).length])),
    activationAllowed: false };
}

/** Conservative exact evidence agreement, not a new fuzzy family/abbreviation dictionary. */
export function assessKnowledgeProposal(evidence, proposal, householdId) {
  const confirmed = evidence.confirmedEvidence;
  const reasons = [];
  if (!proposal) return { status: "needs_review", reasons: ["no_proposal"], activationAllowed: false };
  if (confirmed && (confirmed.householdId !== householdId || confirmed.productId !== evidence.productId)) {
    return { status: "quarantined", reasons: ["evidence_scope_mismatch"], activationAllowed: false };
  }
  const facts = confirmed?.facts ?? [];
  const identity = facts.filter(f => f.relation === "same_product");
  const identityLabels = new Set(identity.map(f => norm(f.label)));
  const exactTerms = unique([proposal.canonicalName, proposal.brand, proposal.productFamily, proposal.variant,
    ...(proposal.searchAliases ?? [])].map(norm));
  const intentTerms = unique((proposal.intentAliases ?? []).map(norm));
  if (confirmed?.collisions?.length) reasons.push("confirmed_alias_points_to_distinct_catalog_identity");
  for (const f of facts) {
    const label = norm(f.label);
    if (f.relation !== "same_product" && exactTerms.includes(label)) reasons.push("intent_relation_is_not_identity");
    if (f.relation === "not_same" && intentTerms.includes(label)) reasons.push("negative_household_feedback");
    if (f.relation !== "same_product" && identityLabels.has(label)) reasons.push("conflicting_household_evidence");
  }
  // A model cannot redefine a confirmed identity. Different wording is held for
  // review too: lexical difference does not establish semantic incompatibility.
  if (identity.length && !identityLabels.has(norm(proposal.canonicalName))) {
    reasons.push("identity_change_requires_confirmation");
  }
  const prior = evidence.activeProfile;
  if (evidence.category && proposal.categoryHint && evidence.category !== proposal.categoryHint) {
    reasons.push("existing_catalog_category_disagrees");
  }
  if (prior?.product_family && norm(prior.product_family) !== norm(proposal.productFamily)) {
    reasons.push("existing_model_family_disagrees");
  }
  const trustedExactTerms = unique(identity.map(f => norm(f.label)));
  const trustedIntentTerms = unique(facts.filter(f => ["fulfills_intent", "substitute"].includes(f.relation)).map(f => norm(f.label)));
  const supported = new Set([...trustedExactTerms, ...trustedIntentTerms]);
  const unsupportedTerms = unique([...exactTerms, ...intentTerms].filter(term => !supported.has(term)));
  const status = reasons.length ? "quarantined" : !identity.length || unsupportedTerms.length ? "needs_review" : "consistent_with_confirmations";
  if (!identity.length) reasons.push("no_confirmed_identity");
  if (unsupportedTerms.length) reasons.push("unsupported_model_terms");
  return { policyVersion: EVIDENCE_POLICY_VERSION, status, reasons: unique(reasons),
    authoritativeExactTerms: trustedExactTerms, authoritativeIntentTerms: trustedIntentTerms,
    unsupportedTerms, sourceReferences: facts.map(f => `${f.source}:${f.sourceId}`),
    // Independent verification/source acquisition and promotion remain separate gates.
    activationAllowed: false };
}
