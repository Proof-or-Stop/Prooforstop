import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {StoryStore} from '../packages/main/dist/core/store.js';
import {resetConfigCache} from '../packages/main/dist/core/config.js';
import {canStartDevGuard,canSkipPlanGuard,canReenterDevGuard,getGuardFailureReason} from '../packages/main/dist/core/machine.js';

const root=mkdtempSync(join(tmpdir(),'story-scope-budget-'));
const storyId='B-scope-budget', at='2026-09-10T00:00:00.000Z';
const config={scanRoot:'packages/main',rootDir:'src',storyDir:'.proof-or-stop/story/actives',workflow:{profile:'light'}};
const policy={schemaVersion:'story-scope-budget.v1',mode:'enforce',
  limits:{responsibilityDomains:1,hostAdapters:100,processFacts:100,publicCommands:100,acceptanceTopology:100,devScopeDelta:100,validationGroups:100},
  responsibilities:[{id:'alpha',paths:['src/alpha/**'],hostAdapters:[],validationGroups:[]},
    {id:'beta',paths:['src/beta/**'],hostAdapters:[],validationGroups:[]}]};
const saveConfig=()=>{writeFileSync(join(root,'proof-or-stop.config.json'),JSON.stringify(config));resetConfigCache();};
try {
  saveConfig();
  execFileSync('git',['init','-b','main'],{cwd:root,stdio:'pipe'});
  execFileSync('git',['add','.'],{cwd:root});
  execFileSync('git',['-c','user.name=Scope Budget Fixture','-c','user.email=fixture@example.test','commit','-m','seed'],{cwd:root,stdio:'pipe'});
  const store=new StoryStore(root);
  store.writeStory(storyId,{storyId,name:storyId,title:'Two responsibility domains',description:'Scope budget fixture',type:'feature',priority:'medium',phase:'PLAN',createdAt:at,startedAt:at,endedAt:null,parallelSafe:'no'});
  store.writeChecklist(storyId,{items:[{id:'CHK-001',title:'Two domains',status:'pending',startTime:null,endTime:null}]});
  store.writeScopeContract(storyId,{storyId,mode:'enforce',allowedModify:['src/alpha/a.ts','src/beta/b.ts'],allowedCreate:[],allowedTest:[],protectedFiles:[],explicitExcludes:[],acknowledgements:[],createdAt:at,updatedAt:at});
  store.writeProofStoryContract(storyId,{schemaVersion:'proofstory.contract.v1',storyId,diagnosticOnly:true,hardeningLevel:'high_assurance',triggerReasons:[],acceptanceBindings:[],diagnosticGaps:[],createdAt:at,updatedAt:at});
  store.writeDevMemoryPreflightAck(storyId,{schemaVersion:'lattice.dev_memory_preflight_ack.v1',storyId,packDigest:'isolated-budget-positive-control',topHitIds:[],acknowledgedAt:at,acknowledgedBy:'scope-budget-fixture'});
  const context={storyId,store,projectRoot:root};
  assert.equal(canStartDevGuard(context),true,'baseline without the new policy can enter DEV');
  config.storyScopeBudget=structuredClone(policy);saveConfig();
  assert.equal(canStartDevGuard(context),false,'U06 DEV must reject two responsibility domains against budget one');
  assert.match(getGuardFailureReason(storyId,store,'DEV',root),/scope budget.*responsibilityDomains/i);
  for(const [phase,guard] of [['INIT_CHECK',canSkipPlanGuard],['TEST',canReenterDevGuard]]) {
    store.writeStory(storyId,{...store.readStory(storyId),phase});
    assert.equal(guard(context),false,`${phase} cannot bypass semantic budget`);
    config.storyScopeBudget.limits.responsibilityDomains=2;saveConfig();
    assert.equal(guard(context),true,`${phase} within-budget positive control`);
    config.storyScopeBudget.limits.responsibilityDomains=1;saveConfig();
  }
  store.writeStory(storyId,{...store.readStory(storyId),phase:'PLAN'});
  // Hundreds of files in one responsibility are not hundreds of domains.
  const scope=store.readScopeContract(storyId);
  scope.allowedModify=Array.from({length:500},(_,n)=>`src/alpha/file-${n}.ts`);
  store.writeScopeContract(storyId,scope);
  assert.equal(canStartDevGuard(context),true,'semantic budget is not a file-count limit');
  scope.allowedModify.push('src/unmapped/new.ts');store.writeScopeContract(storyId,scope);
  assert.equal(canStartDevGuard(context),false,'unknown responsibility must not be counted as zero');
  assert.match(getGuardFailureReason(storyId,store,'DEV',root),/unmapped/);
  console.log('PASS U06 semantic scope budget at DEV entry, quick entry and reentry');
} finally {rmSync(root,{recursive:true,force:true});resetConfigCache();}
