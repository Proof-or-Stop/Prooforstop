import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerHooks } from 'node:module';
import ts from 'typescript';

// Execute this checkout's actual source; no dist sharing or alternate resolver.
registerHooks({
  resolve(specifier, context, next) {
    if (context.parentURL?.endsWith('.ts') && specifier.startsWith('.') && specifier.endsWith('.js')) {
      const source = new URL(specifier.slice(0, -3) + '.ts', context.parentURL);
      if (existsSync(source)) return next(source.href, context);
    }
    return next(specifier, context);
  },
  load(url, context, next) {
    if (!url.endsWith('.ts')) return next(url, context);
    return { format: 'module', shortCircuit: true, source: ts.transpileModule(readFileSync(fileURLToPath(url), 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    }).outputText };
  },
});
const { resolveEffectiveOwnershipClass, enforceStoryOwnerLeaseGate } = await import('../packages/main/src/cli/ownership-gate.ts');
const { acquireOwnerLease, readOwnerLease } = await import('../packages/main/src/core/story-owner-lease.ts');
const root = mkdtempSync(join(tmpdir(), 'intent-owner-lease-'));
const storyId = 'B-ab12';
const storyDir = join(root, storyId);
const envBefore = process.env.PROOF_OR_STOP_AGENT;
const args = { storyId, itemId: 'CHK-001', verificationIntent: { happy: [], edge: [], adversarial: [] } };
try {
  mkdirSync(storyDir);
  acquireOwnerLease(storyDir, { sessionId: 'independent-owner', cwd: root, command: 'test' });
  const before = JSON.stringify(readOwnerLease(storyDir));
  const store = { storyDirPath: () => storyDir };
  process.env.PROOF_OR_STOP_AGENT = 'proof-or-stop-verification-intent';
  assert.equal(resolveEffectiveOwnershipClass('checklist_update', args, storyId), 'reviewerWrite', 'INTENT_OWNER_LEASE_CONFLICT');
  assert.doesNotThrow(() => enforceStoryOwnerLeaseGate('checklist_update', args, store, {storyId,phase:'PLAN'}, root));
  assert.equal(JSON.stringify(readOwnerLease(storyDir)), before, 'independent writer must not take over or refresh owner lease');
  for (const field of ['status','title','context','relatedDocs','userSees','excludes','files','verificationEvidence','takeover','forceTakeover','unknown']) {
    const bad = {...args, [field]: field === 'status' ? 'done' : true};
    assert.equal(resolveEffectiveOwnershipClass('checklist_update', bad, storyId), 'storyScopedMutating', field);
  }
  for (const bad of [{...args, verificationIntent: undefined}, {...args, itemId:''}, {...args, storyId:'../escape'}]) {
    assert.equal(resolveEffectiveOwnershipClass('checklist_update', bad, storyId), 'storyScopedMutating');
  }
  delete process.env.PROOF_OR_STOP_AGENT;
  assert.equal(resolveEffectiveOwnershipClass('checklist_update', {...args,agent:'proof-or-stop-verification-intent'}, storyId), 'storyScopedMutating', 'payload role is not dispatched authority');
  assert.throws(() => enforceStoryOwnerLeaseGate('checklist_update', args, store, {storyId,phase:'PLAN'}, root), /owner|session|lease/i);
  process.env.PROOF_OR_STOP_AGENT='main-agent';
  assert.equal(resolveEffectiveOwnershipClass('checklist_update', args, storyId), 'storyScopedMutating');
  console.log('INTENT_OWNER_LEASE_PASS: bounded independent writer preserves active owner; mixed fields and payload impersonation refused');
} finally {
  if(envBefore === undefined) delete process.env.PROOF_OR_STOP_AGENT; else process.env.PROOF_OR_STOP_AGENT=envBefore;
  rmSync(root,{recursive:true,force:true});
}
