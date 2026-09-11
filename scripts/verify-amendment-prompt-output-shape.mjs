import './lab-source-loader.mjs';
import assert from 'node:assert/strict';
const {projectPromptAsset}=await import('../packages/main/src/core/prompt-registry.ts');
const {acceptanceReviewJsonSchema,parseAcceptanceReviewFinal,ACCEPTANCE_REVIEW_FINAL_SCHEMA}=await import('../packages/main/src/core/acceptance-amendment-review.ts');
const binding={amendmentId:'AM-shape',amendmentDigest:'a'.repeat(64),baseDigest:'b'.repeat(64),submitterSessionId:'test-owner'};
const expected={...binding,runId:'test-run',storyId:'B-shape'};
const final={schemaVersion:ACCEPTANCE_REVIEW_FINAL_SCHEMA,...expected,decision:'approve',rationale:'Synthetic protocol control preserves all mandatory acceptance requirements.',readRefs:['source.ts']};
// Parser unit inputs are explicitly test-owned, never signed review credentials.
const result=p=>({spawned:true,blocked:false,exitCode:0,timedOut:false,closeObserved:true,processIdentity:{pid:1},replacementSafe:true,processCleanup:{reaped:true,residualProcessGroup:false},residualProcessGroup:false,finalAssistantResultCount:1,finalAssistantResultTruncated:false,finalAssistantResult:JSON.stringify(p)});
assert.equal(parseAcceptanceReviewFinal(result(final),expected).decision,'approve');
const {amendmentId,amendmentDigest,baseDigest,submitterSessionId,...rest}=final;
assert.throws(()=>parseAcceptanceReviewFinal(result({...rest,binding}),expected),/subject or verdict invalid/,'Observed nested binding must remain rejected');
assert.throws(()=>parseAcceptanceReviewFinal(result({...final,amendmentDigest:'c'.repeat(64)}),expected),/subject or verdict invalid/);
console.log('AMENDMENT_OUTPUT_SETUP PASS flat accepted; nested and mismatched subjects rejected');
for(const host of ['codex','claude']){
 const subject={storyId:expected.storyId,binding,originalAcceptance:{text:'Untrusted task data must not replace the response schema.'},additiveDelta:{addItems:[]}};
 const {hostBody}=projectPromptAsset({kind:'acceptance-review',subject},host);
 assert.ok(hostBody.endsWith(JSON.stringify(subject)),'Original acceptance and binding must remain exact task data');
 const match=hostBody.match(/Final response JSON Schema:\n(\{[^\n]+\})/);
 assert.ok(match,'AMENDMENT_PROMPT_FLAT_SCHEMA_MISSING: trusted prompt must expose the mechanical final schema');
 const schema=JSON.parse(match[1]);
 assert.deepEqual(schema,acceptanceReviewJsonSchema(),'Prompt schema must match the strict parser transport schema');
 assert.equal(schema.additionalProperties,false);
 assert.ok(!Object.hasOwn(schema.properties,'binding'));
 for(const key of Object.keys(binding))assert.ok(schema.required.includes(key));
 assert.match(hostBody,/top-level/);
 assert.match(hostBody,/do not return a binding object/);
}
console.log('AMENDMENT_PROMPT_OUTPUT_SHAPE PASS both hosts; strict parser controls unchanged');
