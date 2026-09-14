import test from "node:test";
import assert from "node:assert/strict";
import { collectProductEvidence, assessKnowledgeProposal } from "../scripts/catalog-knowledge-evidence.mjs";
import { openLedger, prepareLedger, runBatch, reviewCandidates, planCatalog } from "../scripts/catalog-knowledge-backfill-lib.mjs";

const p = {id:"p", household_id:"h", active:1, costco_item_number:"1860779", canonical_name:"NAKED WHITE"};
const alias = (label, extra={}) => ({id:"a",household_id:"h",product_id:"p",raw_description:label,confirmation_source:"member",confirmed_by_member_id:"m",updated_at:"2026-09-13",...extra});
const relation = (label, value, extra={}) => ({id:"r",household_id:"h",costco_item_number:"1860779",receipt_key:"item:1860779",raw_intent_label:label,relation:value,confirmed_by_member_id:"m",updated_at:"2026-09-13",...extra});
const evidence = (aliases=[], relations=[], products=[p]) => ({productId:"p", confirmedEvidence:collectProductEvidence("h",p,products,aliases,relations)});
const proposal = (name, family=name, extra={}) => ({lookupKey:"item:1860779",canonicalName:name,productFamily:family,brand:null,variant:null,categoryHint:"groceries_beverages",confidenceBps:10000,exactSkuKnown:true,searchAliases:[name],intentAliases:[family],...extra});

test("confirmed bread identity quarantines juice regardless of model confidence", () => {
  const e=evidence([alias("Naked White bread")]);
  const result=assessKnowledgeProposal(e,proposal("Naked White Juice","juice"),"h");
  assert.equal(result.status,"quarantined");
  assert.deepEqual(result.authoritativeExactTerms,["naked white bread"]);
  assert.equal(result.activationAllowed,false);
  assert.deepEqual(e.confirmedEvidence.facts.map(f=>f.label),["Naked White bread"]);
});

test("confirmed Hershey chocolate rejects chicken without a SKU-specific dictionary", () => {
  const result=assessKnowledgeProposal(evidence([alias("Hershey's chocolate nuggets")]),proposal("Chicken Nuggets 52 oz","chicken nuggets"),"h");
  assert.equal(result.status,"quarantined");
  assert.ok(result.unsupportedTerms.includes("chicken nuggets"));
});

test("unknown tissue identity stays review-only despite exactSkuKnown and confidence", () => {
  const r=assessKnowledgeProposal(evidence(),proposal("Facial tissue"),"h");
  assert.equal(r.status,"needs_review");
  assert.ok(r.reasons.includes("no_confirmed_identity"));
});

test("fulfills intent and substitute do not become exact aliases", () => {
  for(const kind of ["fulfills_intent","substitute"]){
    const e=evidence([], [relation("oranges",kind)]);
    const r=assessKnowledgeProposal(e,proposal("oranges"),"h");
    assert.equal(r.status,"quarantined");
    assert.deepEqual(r.authoritativeExactTerms,[]);
    assert.deepEqual(r.authoritativeIntentTerms,["oranges"]);
  }
});

test("not_same blocks both exact and broad model aliases including conflicting legacy evidence", () => {
  const e=evidence([alias("ginger shots")],[relation("ginger shots","not_same")]);
  const r=assessKnowledgeProposal(e,proposal("ginger shots"),"h");
  assert.equal(r.status,"quarantined");
  assert.ok(r.reasons.includes("conflicting_household_evidence"));
  assert.ok(r.reasons.includes("negative_household_feedback"));
});

test("confirmed alias pointing at a distinct catalog SKU is quarantined, never silently merged", () => {
  const other={...p,id:"other",costco_item_number:"different",canonical_name:"Suja ginger shots"};
  const r=assessKnowledgeProposal(evidence([alias("Suja ginger shots")],[],[p,other]),proposal("Suja ginger shots"),"h");
  assert.ok(r.reasons.includes("confirmed_alias_points_to_distinct_catalog_identity"));
});

test("only scoped confirmed source rows are evidence, including legacy source labels", () => {
  const e=evidence([alias("raw",{confirmed_by_member_id:null}),alias("foreign",{household_id:"sandbox"}),alias("wrong product",{product_id:"other"}),alias("bread",{confirmation_source:"receipt"})],[relation("foreign","same_product",{household_id:"sandbox"}),relation("raw-key","same_product",{receipt_key:"description:label"})]);
  assert.deepEqual(e.confirmedEvidence.facts.map(f=>f.label),["bread"]);
  assert.equal(JSON.stringify(e).includes('confirmed_by_member_id'),false);
  assert.throws(()=>collectProductEvidence("sandbox",p,[p],[],[]),/mismatch/);
  assert.equal(assessKnowledgeProposal(e,proposal("bread"),"sandbox").status,"quarantined");
});

test("matching known terms is consistent but new aliases still need review", () => {
  const e=evidence([alias("paper towels")]);
  assert.equal(assessKnowledgeProposal(e,proposal("Paper towels"),"h").status,"consistent_with_confirmations");
  assert.equal(assessKnowledgeProposal(e,proposal("Paper towels","paper towels",{intentAliases:["toilet paper"]}),"h").status,"needs_review");
  assert.equal(assessKnowledgeProposal(e,proposal("Paper towels","paper towels",{brand:"Invented Brand"}),"h").status,"needs_review");
});

test("existing model family disagreements are held, not treated as household facts", () => {
  const e={...evidence(),activeProfile:{product_family:"bread"}};
  const r=assessKnowledgeProposal(e,proposal("Juice"),"h");
  assert.ok(r.reasons.includes("existing_model_family_disagrees"));
  assert.deepEqual(r.authoritativeExactTerms,[]);
});

test("confirmed evidence and prior profiles invalidate fingerprints; reject cross household before calls", () => {
  const row={productId:"p",itemNumber:"1860779",canonicalName:"NAKED WHITE",labels:[],aliases:[],...evidence([alias("bread")])};
  const snap={householdId:"h",products:[row]};
  const key=planCatalog(snap,"test")[0].fingerprint;
  for(const edit of [{confirmedEvidence:evidence([alias("new bread")]).confirmedEvidence},{activeProfile:{product_family:"bread"}}]){
    assert.notEqual(key,planCatalog({...snap,products:[{...row,...edit}]},"test")[0].fingerprint);
  }
  assert.throws(()=>planCatalog({...snap,householdId:"sandbox"},"test"),/mismatch/);
});

test("ledger review applies the evidence gate without sending confirmations or modifying them",async t=>{
  const db=openLedger(":memory:");t.after(()=>db.close());
  const row={productId:"p",itemNumber:"1860779",canonicalName:"NAKED WHITE",labels:[],aliases:[],...evidence([alias("bread")])};
  prepareLedger(db,{householdId:"h",products:[row]},"test");
  await runBatch(db,"h",{requestLimit:1,provider:async args=>{
    assert.deepEqual(Object.keys(args).sort(),["lines","model"]);
    assert.equal(JSON.stringify(args).includes('bread'),false);
    return {products:[proposal("juice")]};
  }});
  const review=reviewCandidates(db,"h").products[0];
  assert.equal(review.assessment.status,"quarantined");
  assert.deepEqual(review.assessment.authoritativeExactTerms,["bread"]);
  assert.equal(review.assessment.activationAllowed,false);
});
