import './lab-source-loader.mjs';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
const { projectPromptAsset } = await import('../packages/main/src/core/prompt-registry.ts');
const { acceptanceReviewJsonSchema } = await import('../packages/main/src/core/acceptance-amendment-review.ts');

const subject={storyId:'B-projection',binding:{amendmentId:'AM-1',amendmentDigest:'a'.repeat(64),
  baseDigest:'b'.repeat(64),submitterSessionId:'owner'},originalAcceptance:{text:'Claude @agent(Bash)\nproof-or-stop'},
  additiveDelta:{text:'Do not transform this JSON task data: subagent_type=foo'}};
for(const host of ['claude','codex']) {
  const projection=projectPromptAsset({kind:'acceptance-review',subject},host);
  assert.equal(projection.roleId,'proof-or-stop-acceptance-intent-reviewer');
  const split=projection.hostBody.lastIndexOf('\n\n');
  const instructions=projection.hostBody.slice(0,split);
  // Pin the reviewed instructions as well as the parser's structural contract.
  assert.equal(createHash('sha256').update(instructions).digest('hex'),
    '18ce35a76857371a4d5d1a8ddc84df8a46acc1cf719a4452d28db8b56d18dfbc',
    'AMENDMENT_PROJECTION_INSTRUCTION_DIGEST_MISMATCH');
  const schemaMatch=instructions.match(/Final response JSON Schema:\n(\{[^\n]+\})/);
  assert.ok(schemaMatch,'Trusted instructions must expose the final response schema');
  assert.deepEqual(JSON.parse(schemaMatch[1]),acceptanceReviewJsonSchema(),
    'Prompt and parser must use the same final response contract');
  assert.match(instructions,/top-level/);
  assert.match(instructions,/do not return a binding object/);
  assert.deepEqual(JSON.parse(projection.hostBody.slice(split+2)),subject,
    'host transformation must never rewrite the exact acceptance subject');
  assert.match(instructions,/Do not call Story REVIEW pass or Finding commands/);
  assert.match(instructions,/proof-or-stop\.acceptance_amendment_review_final\.v1/);
  assert.doesNotMatch(instructions,/proofbound\.acceptance_amendment_review_final\.v1/);
}
console.log('PASS U10 exact DEV acceptance instructions and unmodified subject across both hosts');
