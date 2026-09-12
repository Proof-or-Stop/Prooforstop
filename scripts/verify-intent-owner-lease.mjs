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
const { acquireOwnerLease, readOwnerLease, resetSessionIdForTest } = await import('../packages/main/src/core/story-owner-lease.ts');
const { StoryStore } = await import('../packages/main/src/core/store.ts');
const { resetConfigCache } = await import('../packages/main/src/core/config.ts');
const { createChecklistHandlers } = await import('../packages/main/src/handlers/checklist.ts');
const root = mkdtempSync(join(tmpdir(), 'intent-owner-lease-'));
const storyId = 'B-ab12';
const storyDir = join(root, storyId);
const envBefore = process.env.PROOF_OR_STOP_AGENT;
const sessionBefore = process.env.PROOF_OR_STOP_SESSION_ID;
const args = { storyId, itemId: 'CHK-001', verificationIntent: {"happy": [{"desc": "Execute the readiness probe and focused regression verifier; assert a structured bounded report identifies source/build/environment bindings and separately classifies actual sandbox observations, launch profile, raw usage retention, reviewer-import support and machine admission, without claiming M1 runner completion.", "type": "cli", "priority": "must", "scope": "focused", "expectation": "absolute_pass", "requirementSource": "story", "plannedPathDeclarations": [{"schemaVersion": "proofstory.verification_planned_path_declaration.v1", "id": "PD-M0-READINESS", "relation": "producer_to_consumer", "outputFactRef": "bounded-m0-readiness-report", "producer": {"id": "P-M0-COLLECTOR", "role": "producer", "expectedArtifactKind": "source_file", "expectedFileRef": "scripts/benchmark/feasibility.mjs", "expectedSymbolOrFact": "bounded readiness report", "fileDeclarationRef": "CHK-001:files:create:0"}, "consumers": [{"id": "C-M0-VERIFIER", "role": "consumer", "expectedArtifactKind": "source_file", "expectedFileRef": "scripts/verify-benchmark-feasibility.mjs", "expectedSymbolOrFact": "documentation collector and published-report consistency assertions", "fileDeclarationRef": "CHK-001:files:test:0"}]}]}], "edge": [{"desc": "Execute synthetic readiness cases for missing executable or build, absent usage or receipts, unavailable sandbox observations and blocked prerequisites; assert explicit unknown or blocked reasons remain visible and readiness is not promoted from missing evidence.", "type": "cli", "priority": "must", "scope": "focused", "expectation": "absolute_pass", "requirementSource": "story"}], "adversarial": [{"desc": "Execute synthetic cases with stale or inconsistent source/build bindings, diagnostic-only usage and static capability assertions presented as live proof; assert fail-closed readiness classification and no unrequested provider launch, lifecycle mutation or alternate machine admission pool.", "type": "cli", "priority": "must", "scope": "focused", "expectation": "absolute_pass", "requirementSource": "story"}]} };
try {
  mkdirSync(storyDir);
  process.env.PROOF_OR_STOP_SESSION_ID='fixture-owner'; resetSessionIdForTest();
  acquireOwnerLease(storyDir, { cwd: root, command: 'test' });
  process.env.PROOF_OR_STOP_SESSION_ID='fixture-independent'; resetSessionIdForTest();
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
  // Exercise the real handler's phase and field boundary on disposable Story data.
  writeFileSync(join(root,'proof-or-stop.config.json'),JSON.stringify({scanRoot:'packages/main',rootDir:'src',storyDir:'.proof-or-stop/story/actives'}));
  resetConfigCache();
  const realStore = new StoryStore(root);
  const now = new Date().toISOString();
  const story = {storyId,name:'intent-lease',title:'Intent lease regression',description:'Independent intent authoring regression',type:'chore',phase:'PLAN',priority:'medium',createdAt:now,startedAt:now,endedAt:null,events:[]};
  realStore.writeStory(storyId,story);
  realStore.writeChecklist(storyId,{items:[{id:'CHK-001',title:'Record intent',context:'Focused regression',status:'pending',files:{create:['scripts/benchmark/feasibility.mjs'],modify:[],test:['scripts/verify-benchmark-feasibility.mjs']}}]});
  const handlers=createChecklistHandlers({store:realStore,root,scanRoot:join(root,'packages/main')});
  const priorCwd=process.cwd();
  process.chdir(root);
  try {
    process.env.PROOF_OR_STOP_AGENT='proof-or-stop-verification-intent';
    await handlers.checklist_update(args);
    assert.deepEqual(realStore.readChecklist(storyId).items[0].verificationIntent.happy[0].plannedPathDeclarations, args.verificationIntent.happy[0].plannedPathDeclarations);
    for(const phase of ['INIT','DEV','REVIEW','TEST','DONE']) {
      realStore.writeStory(storyId,{...story,phase});
      await assert.rejects(async()=>handlers.checklist_update(args), /verification_intent_writer_phase_invalid|phase|frozen/i);
    }
    realStore.writeStory(storyId,story);
    await assert.rejects(async()=>handlers.checklist_update({...args,status:'done'}), /agent_dispatch_mutation_scope_denied/);
  } finally {process.chdir(priorCwd);}
  console.log('INTENT_OWNER_LEASE_PASS: bounded independent writer preserves active owner; mixed fields and payload impersonation refused');
} finally {
  if(envBefore === undefined) delete process.env.PROOF_OR_STOP_AGENT; else process.env.PROOF_OR_STOP_AGENT=envBefore;
  if(sessionBefore === undefined) delete process.env.PROOF_OR_STOP_SESSION_ID; else process.env.PROOF_OR_STOP_SESSION_ID=sessionBefore;
  resetSessionIdForTest();
  rmSync(root,{recursive:true,force:true});
}
