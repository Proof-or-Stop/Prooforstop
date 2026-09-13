import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdirSync,mkdtempSync,rmSync,symlinkSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {StoryStore} from '../packages/main/dist/core/store.js';
import {resetConfigCache} from '../packages/main/dist/core/config.js';
import {canStartDevGuard,canSkipPlanGuard,canReenterDevGuard,getGuardFailureReason} from '../packages/main/dist/core/machine.js';
import {evaluateStoryScopeBudget,readStoryScopeBudget,storyScopeBudgetBlocker} from '../packages/main/dist/core/story-scope-budget.js';
import {deriveAcceptanceAmendment} from '../packages/main/dist/core/acceptance-amendment.js';
import {createStoryScopeBudgetHandlers} from '../packages/main/dist/handlers/story-scope-budget.js';

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
  const budgetAllows=()=>{const r=readStoryScopeBudget(store,root,storyId);assert.equal(storyScopeBudgetBlocker(store,root,storyId)===null,!r.blocking);return !r.blocking;};
  assert.equal(budgetAllows(),true,'baseline without policy has no scope-budget blocker');
  config.storyScopeBudget=structuredClone(policy);saveConfig();
  assert.equal(canStartDevGuard(context),false,'U06 DEV must reject two responsibility domains against budget one');
  assert.match(getGuardFailureReason(storyId,store,'DEV',root),/scope budget.*responsibilityDomains/i);
  for(const [phase,guard] of [['INIT_CHECK',canSkipPlanGuard],['TEST',canReenterDevGuard]]) {
    store.writeStory(storyId,{...store.readStory(storyId),phase});
    assert.equal(guard(context),false,`${phase} cannot bypass semantic budget`);
    assert.equal(budgetAllows(),false,`${phase} has a scope-budget blocker`);
    config.storyScopeBudget.limits.responsibilityDomains=2;saveConfig();
    assert.equal(budgetAllows(),true,`${phase} within-budget positive control`);
    config.storyScopeBudget.limits.responsibilityDomains=1;saveConfig();
  }
  store.writeStory(storyId,{...store.readStory(storyId),phase:'PLAN'});
  // Hundreds of files in one responsibility are not hundreds of domains.
  const scope=store.readScopeContract(storyId);
  scope.allowedModify=Array.from({length:500},(_,n)=>`src/alpha/file-${n}.ts`);
  store.writeScopeContract(storyId,scope);
  assert.equal(budgetAllows(),true,'semantic budget is not a file-count limit');
  scope.allowedModify.push('src/unmapped/new.ts');store.writeScopeContract(storyId,scope);
  assert.equal(canStartDevGuard(context),false,'unknown responsibility must not be counted as zero');
  assert.match(getGuardFailureReason(storyId,store,'DEV',root),/unmapped/);
  const before=JSON.stringify([store.readChecklist(storyId),store.readScopeContract(storyId),store.readProofStoryContract(storyId)]);
  const projection=JSON.parse(createStoryScopeBudgetHandlers({store,root}).scope_budget_check({storyId,json:true}));
  assert.equal(projection.readOnly,true);assert.equal(projection.blocking,true);
  assert.equal(JSON.stringify([store.readChecklist(storyId),store.readScopeContract(storyId),store.readProofStoryContract(storyId)]),before);

  const subject={storyId,scope:{...scope,allowedModify:['src/alpha/a.ts']},checklist:store.readChecklist(storyId),proofStory:store.readProofStoryContract(storyId)};
  const evaluate=(candidate=subject,policyChange=()=>{},base)=>{
    const cfg=structuredClone(config);cfg.storyScopeBudget=structuredClone(policy);
    policyChange(cfg.storyScopeBudget,cfg);
    return evaluateStoryScopeBudget(candidate,cfg,base);
  };
  let report=evaluate(subject,p=>{p.responsibilities[0].hostAdapters=['codex','claude'];p.limits.hostAdapters=1;});
  assert.equal(report.counts.hostAdapters,2);assert.ok(report.exceeded.includes('hostAdapters'));assert.equal(report.blocking,true);
  assert.equal(evaluate(subject,p=>{p.responsibilities[0].hostAdapters=['unregistered-host'];}).status,'unknown');
  report=evaluate(subject,(p,cfg)=>{
    cfg.validate={commands:[{label:'test-alpha',command:'node',args:['alpha.mjs']},{label:'test-beta',command:'node',args:['beta.mjs']}]};
    p.validationGroups=[{id:'alpha-tests',commandLabels:['test-alpha']},{id:'beta-tests',commandLabels:['test-beta']}];
    p.responsibilities[0].validationGroups=['alpha-tests','beta-tests'];p.limits.validationGroups=1;
  });
  assert.equal(report.counts.validationGroups,2);assert.ok(report.exceeded.includes('validationGroups'));
  const factSubject=structuredClone(subject);factSubject.scope.allowedModify=['packages/main/src/core/story-scope-budget.ts'];
  report=evaluate(factSubject,p=>{p.responsibilities=[{id:'budget',paths:['packages/main/src/**'],hostAdapters:[],validationGroups:[]}];p.limits.processFacts=0;});
  assert.ok(report.facts.processFacts.includes('runtime:story_scope_budget'));assert.ok(report.exceeded.includes('processFacts'));
  factSubject.scope.allowedModify=['packages/main/src/handlers/story-scope-budget.ts'];
  report=evaluate(factSubject,p=>{p.responsibilities=[{id:'budget',paths:['packages/main/src/**'],hostAdapters:[],validationGroups:[]}];p.limits.publicCommands=0;});
  assert.ok(report.facts.publicCommands.includes('scope_budget_check'));assert.ok(report.exceeded.includes('publicCommands'));

  // This is the actual additive amendment producer, not a caller-authored next snapshot.
  const amendmentBase=structuredClone(subject);
  amendmentBase.checklist.items[0].files={modify:['src/alpha/a.ts'],create:[],test:[]};
  amendmentBase.checklist.items[0].verificationIntent={happy:[],edge:[],adversarial:[]};
  const ref={refKind:'existing',canonicalSourceRef:'intent:CHK-001:happy:0'};
  const binding={id:'AB-NEW',checklistRefs:['CHK-001'],verificationIntentRefs:['CHK-001:happy:0'],milestoneIds:[],
    verificationTopology:{schemaVersion:'proofstory.acceptance_topology.v1',
      producerRefs:[{id:'P',sourceRef:{refKind:'existing',canonicalSourceRef:'process-fact:checklist_update'}}],
      consumerRefs:[{id:'C',sourceRef:{refKind:'existing',canonicalSourceRef:'process-fact:story_advance'},producerRefs:['P']}],
      positiveAssertionRefs:[{id:'A',sourceRef:ref,producerRefs:['P'],consumerRefs:['C']}],
      mutationCaseRefs:[{id:'M',sourceRef:ref,producerRefs:['P'],consumerRefs:['C']}],transcriptAssertionRefs:[],commandRefs:[ref]}};
  const next=deriveAcceptanceAmendment(amendmentBase,{addItems:[],appendIntents:[{itemId:'CHK-001',verificationIntent:{happy:[{desc:'Additional mandatory boundary',type:'cli',priority:'must'}],edge:[],adversarial:[]}}],scopeDelta:{modify:[],create:[],test:[]},topologyDelta:[binding]});
  report=evaluate(next,p=>{p.limits.devScopeDelta=0;},amendmentBase);
  assert.ok(report.exceeded.includes('devScopeDelta'));assert.equal(report.blocking,true);
  assert.ok(report.facts.devScopeDelta.some(id=>id.startsWith('acceptance:intent:CHK-001:')));
  assert.equal(report.counts.acceptanceTopology,10,'one binding, four nodes and five edges');
  assert.ok(evaluate(next,p=>{p.limits.acceptanceTopology=9;}).exceeded.includes('acceptanceTopology'));
  const repeated=structuredClone(next);repeated.proofStory.acceptanceBindings[0].verificationTopology.producerRefs.push({id:'P',sourceRef:ref});
  assert.equal(evaluate(repeated).status,'unknown','duplicate identities cannot disappear through deduplication');
  const semanticDrift=structuredClone(next);semanticDrift.checklist.items[0].verificationIntent.happy[0].desc='Changed meaning under the same ID';
  assert.ok(evaluate(semanticDrift,p=>{p.limits.devScopeDelta=0;},next).exceeded.includes('devScopeDelta'),
    'direct same-ID semantic drift remains visible even though the amendment deriver rejects replacement');
  report=evaluate(next,p=>{p.mode='observe';p.limits.acceptanceTopology=0;});
  assert.equal(report.status,'decision_required');assert.equal(report.blocking,false,'explicit observe mode is diagnostic');
  mkdirSync(join(root,'src/alpha'),{recursive:true});mkdirSync(join(root,'src/beta'),{recursive:true});
  writeFileSync(join(root,'src/beta/b.ts'),'export const beta=1;');
  store.writeScopeContract(storyId,{...scope,allowedModify:['src/alpha']});
  config.storyScopeBudget.responsibilities[0].paths=['src/alpha'];saveConfig();
  assert.equal(canStartDevGuard(context),false,'a directory grant is not one literal file in one responsibility');
  assert.match(getGuardFailureReason(storyId,store,'DEV',root),/scope directory/);
  symlinkSync('../beta/b.ts',join(root,'src/alpha/a.ts'));
  store.writeScopeContract(storyId,{...scope,allowedModify:['src/alpha/a.ts']});
  assert.equal(canStartDevGuard(context),false,'symlink alias cannot hide a different responsibility');
  assert.match(getGuardFailureReason(storyId,store,'DEV',root),/scope alias/);
  writeFileSync(join(root,'proof-or-stop.config.json'),'{broken');resetConfigCache();
  assert.equal(canReenterDevGuard(context),false,'invalid configuration cannot downgrade an enforced budget into absent policy');
  assert.notEqual(storyScopeBudgetBlocker(store,root,storyId),null,'malformed config produces a budget-specific blocker');
  const amendmentOutput=execFileSync(process.execPath,['scripts/verify-acceptance-amendment-journal.mjs','--scope-budget'],
    {encoding:'utf8',timeout:60_000,maxBuffer:4*1024*1024});
  assert.ok(amendmentOutput.includes('PASS U06 reviewed amendment cannot apply over semantic budget'));
  console.log('PASS U06 semantic scope budget at DEV entry, quick entry and reentry');
} finally {rmSync(root,{recursive:true,force:true});resetConfigCache();}
