import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { projectPromptAsset } from '../packages/main/dist/core/prompt-registry.js';

const subject={storyId:'B-projection',binding:{amendmentId:'AM-1',amendmentDigest:'a'.repeat(64),
  baseDigest:'b'.repeat(64),submitterSessionId:'owner'},originalAcceptance:{text:'Claude @agent(Bash)\nproof-or-stop'},
  additiveDelta:{text:'Do not transform this JSON task data: subagent_type=foo'}};
for(const host of ['claude','codex']) {
  const projection=projectPromptAsset({kind:'acceptance-review',subject},host);
  assert.equal(projection.roleId,'proof-or-stop-acceptance-intent-reviewer');
  const split=projection.hostBody.lastIndexOf('\n\n');
  const instructions=projection.hostBody.slice(0,split);
  // Exact pre-migration static instructions from 047b617aef, independently captured.
  assert.equal(createHash('sha256').update(instructions).digest('hex'),
    '5a0e74ded9519bb393179b37f0470fbfeb4dc0746f86d81c71c7a7ca554e54ab');
  assert.deepEqual(JSON.parse(projection.hostBody.slice(split+2)),subject,
    'host transformation must never rewrite the exact acceptance subject');
  assert.match(instructions,/Do not call Story REVIEW pass or Finding commands/);
  assert.match(instructions,/proofbound.acceptance_amendment_review_final.v1/);
}
console.log('PASS U10 exact DEV acceptance instructions and unmodified subject across both hosts');
