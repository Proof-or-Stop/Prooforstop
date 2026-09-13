import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {StoryStore} from '../packages/main/dist/core/store.js';
import {resetConfigCache} from '../packages/main/dist/core/config.js';
import {canStartDevGuard} from '../packages/main/dist/core/machine.js';
import {createStoryScopeBudgetHandlers} from '../packages/main/dist/handlers/story-scope-budget.js';

import {base,delta} from './verify-acceptance-amendment-delta.mjs';
import {createAcceptanceAmendmentController} from '../packages/main/dist/core/acceptance-amendment-journal.js';
import {deriveAcceptanceAmendment} from '../packages/main/dist/core/acceptance-amendment.js';
import {readStoryScopeBudget,storyScopeBudgetBlocker} from '../packages/main/dist/core/story-scope-budget.js';

const root=mkdtempSync(join(tmpdir(),'scope-budget-approval-'));
const storyId='B-budget-approval',at=new Date().toISOString();
const config={scanRoot:'packages/main',rootDir:'src',storyDir:'.proof-or-stop/story/actives',workflow:{profile:'light'},
  storyScopeBudget:{schemaVersion:'story-scope-budget.v1',mode:'enforce',limits:{responsibilityDomains:1,hostAdapters:10,processFacts:100,publicCommands:100,acceptanceTopology:100,devScopeDelta:100,validationGroups:10},
    responsibilities:[{id:'alpha',paths:['src/alpha/**'],hostAdapters:[],validationGroups:[]},{id:'beta',paths:['src/beta/**'],hostAdapters:[],validationGroups:[]}]}};
const env={...process.env};
const stdinTTY=Object.getOwnPropertyDescriptor(process.stdin,'isTTY');
const stdoutTTY=Object.getOwnPropertyDescriptor(process.stdout,'isTTY');
try {
  writeFileSync(join(root,'proof-or-stop.config.json'),JSON.stringify(config));
  execFileSync('git',['init','-b','main'],{cwd:root,stdio:'pipe'});execFileSync('git',['add','.'],{cwd:root});
  execFileSync('git',['-c','user.name=Budget Fixture','-c','user.email=fixture@example.test','commit','-m','seed'],{cwd:root,stdio:'pipe'});
  resetConfigCache();const store=new StoryStore(root),context={storyId,store,projectRoot:root};
  store.writeStory(storyId,{storyId,name:storyId,title:'Explicit large scope',description:'Approval boundary fixture',type:'feature',phase:'PLAN',priority:'medium',createdAt:at,startedAt:at,endedAt:null,parallelSafe:'no'});
  store.writeChecklist(storyId,{items:[{id:'CHK-001',title:'Cover two domains',status:'pending',startTime:null,endTime:null}]});
  store.writeScopeContract(storyId,{storyId,mode:'enforce',allowedModify:['src/alpha/a.ts','src/beta/b.ts'],allowedCreate:[],allowedTest:[],protectedFiles:[],explicitExcludes:[],acknowledgements:[],createdAt:at,updatedAt:at});
  store.writeProofStoryContract(storyId,{schemaVersion:'proofstory.contract.v1',storyId,diagnosticOnly:true,hardeningLevel:'high_assurance',triggerReasons:[],acceptanceBindings:[],diagnosticGaps:[],createdAt:at,updatedAt:at});
  store.writeDevMemoryPreflightAck(storyId,{schemaVersion:'lattice.dev_memory_preflight_ack.v1',storyId,packDigest:'budget-approval-control',topHitIds:[],acknowledgedAt:at,acknowledgedBy:'fixture'});
  const budgetAllows=()=>{const r=readStoryScopeBudget(store,root,storyId);assert.equal(storyScopeBudgetBlocker(store,root,storyId)===null,!r.blocking);return !r.blocking;};
  const handlers=createStoryScopeBudgetHandlers({store,root});
  assert.equal(canStartDevGuard(context),false,'over-budget scope initially blocks DEV');
  assert.equal(budgetAllows(),false,'over-budget scope initially blocks');
  assert.equal(typeof handlers.scope_budget_approve,'function','U06 explicit large Story approval must be available without widening policy');
  const report=JSON.parse(handlers.scope_budget_check({storyId,json:true}));
  const args={storyId,ack:true,bindingDigest:report.bindingDigest,confirmationToken:`APPROVE LARGE STORY ${storyId} ${report.bindingDigest}`,
    reason:'This isolated test exercises deliberate operator approval of two coupled responsibilities.'};
  Object.defineProperty(process.stdin,'isTTY',{value:false,configurable:true});
  assert.throws(()=>handlers.scope_budget_approve(args),/interactive|terminal|operator/i);
  assert.equal(store.readScopeBudgetDecisions(storyId),null,'noninteractive refusal writes no approval');

  // Simulated operator channel for isolated fixture data; this is not a real
  // human approval or a claim that TTY possession proves human identity.
  for(const key of Object.keys(process.env)) if(/(?:CODEX|CLAUDE|LATTICE|PROOF_OR_STOP|AUTOPILOT|NON_INTERACTIVE)/.test(key)||key==='CI') delete process.env[key];
  Object.defineProperty(process.stdin,'isTTY',{value:true,configurable:true});
  Object.defineProperty(process.stdout,'isTTY',{value:true,configurable:true});
  assert.throws(()=>handlers.scope_budget_approve({...args,ack:false}),/ack/i);
  assert.throws(()=>handlers.scope_budget_approve({...args,confirmationToken:'APPROVE'}),/confirmation/i);
  process.env.PROOF_OR_STOP_AGENT='proof-or-stop-implementer';
  assert.throws(()=>handlers.scope_budget_approve(args),/agent|operator/i);
  delete process.env.PROOF_OR_STOP_AGENT;
  const accepted=JSON.parse(handlers.scope_budget_approve(args));
  assert.equal(accepted.decision.kind,'human-large-story');
  assert.equal(budgetAllows(),true,'current signed approval allows large scope without raising the limit');
  assert.equal(config.storyScopeBudget.limits.responsibilityDomains,1);
  const journal=store.readScopeBudgetDecisions(storyId);
  assert.deepEqual(JSON.parse(handlers.scope_budget_approve(args)).decision,accepted.decision,'exact acknowledgement retry is idempotent');
  const forged=structuredClone(journal);forged.decisions[0].reason='caller changed signed authority';store.writeScopeBudgetDecisions(storyId,forged);
  assert.equal(budgetAllows(),false,'tampered decision cannot authorize DEV');
  store.writeScopeBudgetDecisions(storyId,journal);
  const scope=store.readScopeContract(storyId);scope.allowedModify.push('src/alpha/new.ts');store.writeScopeContract(storyId,scope);
  assert.equal(budgetAllows(),false,'changed scope invalidates the approval even within the same domains');
  scope.allowedModify.pop();store.writeScopeContract(storyId,scope);
  assert.equal(budgetAllows(),true,'exact original subject retains its valid approval');
  const clock=Date.now;
  try {Date.now=()=>Date.parse(accepted.decision.expiresAt)+1;assert.equal(budgetAllows(),false,'expired approval is not authority');}
  finally {Date.now=clock;}
  const amendmentConfig=structuredClone(config);
  amendmentConfig.storyScopeBudget.responsibilities=[{id:'addition',paths:['src/**','tests/**'],hostAdapters:[],validationGroups:[]}];
  amendmentConfig.storyScopeBudget.limits.acceptanceTopology=1;
  amendmentConfig.storyScopeBudget.limits.devScopeDelta=0;
  writeFileSync(join(root,'proof-or-stop.config.json'),JSON.stringify(amendmentConfig));resetConfigCache();
  const amendmentStory=base.storyId;
  store.writeStory(amendmentStory,{storyId:amendmentStory,name:amendmentStory,title:'Scope amendment approval',phase:'DEV',priority:'medium',createdAt:at});
  store.writeChecklist(amendmentStory,base.checklist);store.writeScopeContract(amendmentStory,base.scope);store.writeProofStoryContract(amendmentStory,base.proofStory);
  const controller=createAcceptanceAmendmentController(store,root);
  controller.propose({storyId:amendmentStory,amendmentId:'AM-budget',delta,submitterSessionId:'fixture-owner'});
  const projected=JSON.parse(handlers.scope_budget_check({storyId:amendmentStory,amendmentId:'AM-budget'}));
  const amendmentArgs={...args,storyId:amendmentStory,amendmentId:'AM-budget',bindingDigest:projected.bindingDigest,confirmationToken:projected.confirmationToken};
  const drift=structuredClone(base.checklist);drift.items[0].title+=' drift';store.writeChecklist(amendmentStory,drift);
  assert.throws(()=>handlers.scope_budget_check({storyId:amendmentStory,amendmentId:'AM-budget'}),/base drift/);
  assert.throws(()=>handlers.scope_budget_approve(amendmentArgs),/base drift/);
  assert.equal(store.readScopeBudgetDecisions(amendmentStory),null,'stale amendment cannot acquire approval');
  store.writeChecklist(amendmentStory,base.checklist);
  handlers.scope_budget_approve(amendmentArgs);
  const next=deriveAcceptanceAmendment(base,delta);
  assert.equal(readStoryScopeBudget(store,root,amendmentStory,next,base).status,'approved_large_story','exact growth is authorized');
  assert.equal(readStoryScopeBudget(store,root,amendmentStory,next).status,'approved_large_story','resulting scope retains permission after application');
  const otherBase=structuredClone(base);otherBase.checklist.items[0].title+=' different base';
  assert.equal(readStoryScopeBudget(store,root,amendmentStory,next,otherBase).blocking,true,'same next does not authorize growth from another base');
  execFileSync(process.execPath,['scripts/verify-acceptance-amendment-journal.mjs','--scope-budget-approval'],{stdio:'pipe',timeout:60000});
  console.log('PASS U06 explicit large scope approval, channel refusal, exact binding, tamper and expiry');
} finally {
  for(const key of Object.keys(process.env)) if(!(key in env)) delete process.env[key];Object.assign(process.env,env);
  if(stdinTTY) Object.defineProperty(process.stdin,'isTTY',stdinTTY);else delete process.stdin.isTTY;
  if(stdoutTTY) Object.defineProperty(process.stdout,'isTTY',stdoutTTY);else delete process.stdout.isTTY;
  rmSync(root,{recursive:true,force:true});resetConfigCache();
}
