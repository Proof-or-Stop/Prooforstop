import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const read=path=>readFileSync(path,'utf8');
const agent=read('packages/main/src/handlers/agent-prompt.ts');
const contracts=read('packages/main/src/core/prompt-role-contract-registry.ts');
const tests=read('packages/main/src/tasks/prompt-registry-smoke.ts');
assert.ok(!read('packages/main/src/core/global-agents.ts').includes('isModularReviewerRoleId')
  && !read('packages/main/src/core/acceptance-amendment-journal.ts').includes('You are the independent DEV acceptance intent reviewer'),
  'U10: global shims and DEV acceptance reviewer must consume the same prompt projection');
assert.ok(!agent.includes('isActiveModularReviewerRoleId')
  && !contracts.includes('purposeSelectedCriticBody')
  && !contracts.includes('resolvePromptTemplateBody')
  && !contracts.includes('readPromptTemplate')
  && !tests.includes('const canonicalLegacy = legacy'),
  'U10: prompt consumers must not duplicate role selection or expected legacy render reconstruction');
for(const script of ['scripts/verify-proof-or-stop-prompt-baseline.mjs',
  'packages/main/dist/tasks/prompt-registry-smoke.js',
  'packages/main/dist/tasks/global-agents-init-smoke.js',
  'packages/main/dist/tasks/prompt-token-cost-smoke.js']) {
  const result=spawnSync(process.execPath,[script],{encoding:'utf8',timeout:300000,maxBuffer:8*1024*1024});
  process.stdout.write(result.stdout??''); process.stderr.write(result.stderr??'');
  assert.equal(result.status,0,`observable prompt contract regression: ${script}`);
}
console.log('PASS U10 single prompt projection and existing role/host contracts');
