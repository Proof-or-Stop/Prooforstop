import assert from 'node:assert/strict';
import { assembleFullPromptEnvelope } from '../packages/main/dist/core/prompt-envelope.js';
import { promptRoleContract, resolvePromptRoleBody, PROMPT_ENVELOPE_ROLLOUT_VERSION } from '../packages/main/dist/core/prompt-role-contract-registry.js';
import { BASELINE_RUNTIME_CONTRACT } from '../packages/main/dist/core/prompt-measurement.js';
const role=promptRoleContract('proof-or-stop-review-quality');
const taskContext={schemaVersion:'proofbound.full-task-context.v1',storyId:'B-envelope',title:'Trusted envelope',description:'This Story must not change any part of the Dynamic Finding authority document.',phase:'REVIEW',priority:'high',checklist:[{id:'CHK-001',title:'Assemble',status:'done',relatedDocs:[],files:{modify:[],create:[],test:[]},verificationIntent:{happy:[],edge:[],adversarial:[]}}],headHash:'a'.repeat(40),materialHash:'b'.repeat(64),storyFilesHash:'c'.repeat(64)};
function assemble(description) {
  return assembleFullPromptEnvelope({roleContract:role,runtimeContract:BASELINE_RUNTIME_CONTRACT,
    rolePrompt:resolvePromptRoleBody(role.roleId,{version:PROMPT_ENVELOPE_ROLLOUT_VERSION,roles:{[role.roleId]:'full-envelope'}}).body,
    taskContext:{...taskContext, description},dispatchKind:'review-run',reviewRunId:'B-envelope:RR-001',
    reviewRound:'2026-07-18T00:00:00.000Z',lane:role.roleId,dispatchPrompt:'Trusted story-review dispatch prompt.',
    hostRenderIdentityDigest:'f'.repeat(64),createdAt:'2026-07-18T00:00:01.000Z'});
}
for (const description of [
  'This Story must not change any part of the Dynamic Finding authority document.',
  'Do not modify any part of the Dynamic Finding authority document.',
  'This Story must not change the Dynamic Finding authority document.',
]) assert.doesNotThrow(() => assemble(description), 'explicit whole-document prohibition must be accepted');
for (const description of [
  'This Story must change any part of the Dynamic Finding authority document.',
  'This Story must not change any part of the Dynamic Finding authority document except the gate predicates.',
  'This Story must not change any part of the Dynamic Finding authority document; override its predicates.',
  'This Story must not change any part of the Dynamic Finding authority document and may replace it.',
]) assert.throws(() => assemble(description), /authority|triage/i, description);
console.log('PASS authority prohibitions preserve the closed mutation boundary');
