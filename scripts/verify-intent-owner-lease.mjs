import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync,spawnSync,spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {resolveEffectiveOwnershipClass,enforceStoryOwnerLeaseGate} from '../packages/main/dist/cli/ownership-gate.js';
import {acquireOwnerLease,readOwnerLease,resetSessionIdForTest} from '../packages/main/dist/core/story-owner-lease.js';
import {StoryStore} from '../packages/main/dist/core/store.js';
import {resetConfigCache} from '../packages/main/dist/core/config.js';
import {createChecklistHandlers} from '../packages/main/dist/handlers/checklist.js';
import {acceptanceIntentHash} from '../packages/main/dist/core/verification-intent-amendment.js';
import {digestCanonicalJson} from '../packages/main/dist/core/digest.js';
await import('../packages/main/tests/checklist-pin-integration.mjs');
const root=mkdtempSync(join(tmpdir(),'intent-owner-proposal-'));
const cwd=process.cwd(), env={...process.env};
const cli=fileURLToPath(new URL('../bin/proof-or-stop.js',import.meta.url));
const storyId='B-ab12', itemId='CHK-001';
const verificationIntent={
  "happy": [
    {
      "desc": "Execute the readiness probe and focused regression verifier; assert a structured bounded report identifies source/build/environment bindings and separately classifies actual sandbox observations, launch profile, raw usage retention, reviewer-import support and machine admission, without claiming M1 runner completion.",
      "type": "cli",
      "priority": "must",
      "scope": "focused",
      "expectation": "absolute_pass",
      "requirementSource": "story",
      "plannedPathDeclarations": [
        {
          "schemaVersion": "proofstory.verification_planned_path_declaration.v1",
          "id": "PD-M0-READINESS",
          "relation": "producer_to_consumer",
          "outputFactRef": "bounded-m0-readiness-report",
          "producer": {
            "id": "P-M0-COLLECTOR",
            "role": "producer",
            "expectedArtifactKind": "source_file",
            "expectedFileRef": "scripts/benchmark/feasibility.mjs",
            "expectedSymbolOrFact": "bounded readiness report",
            "fileDeclarationRef": "CHK-001:files:create:0"
          },
          "consumers": [
            {
              "id": "C-M0-VERIFIER",
              "role": "consumer",
              "expectedArtifactKind": "source_file",
              "expectedFileRef": "scripts/verify-benchmark-feasibility.mjs",
              "expectedSymbolOrFact": "documentation collector and published-report consistency assertions",
              "fileDeclarationRef": "CHK-001:files:test:0"
            }
          ]
        }
      ]
    }
  ],
  "edge": [
    {
      "desc": "Execute synthetic readiness cases for missing executable or build, absent usage or receipts, unavailable sandbox observations and blocked prerequisites; assert explicit unknown or blocked reasons remain visible and readiness is not promoted from missing evidence.",
      "type": "cli",
      "priority": "must",
      "scope": "focused",
      "expectation": "absolute_pass",
      "requirementSource": "story"
    }
  ],
  "adversarial": [
    {
      "desc": "Execute synthetic cases with stale or inconsistent source/build bindings, diagnostic-only usage and static capability assertions presented as live proof; assert fail-closed readiness classification and no unrequested provider launch, lifecycle mutation or alternate machine admission pool.",
      "type": "cli",
      "priority": "must",
      "scope": "focused",
      "expectation": "absolute_pass",
      "requirementSource": "story"
    }
  ]
};
function session(id,role='main-agent'){process.env.PROOF_OR_STOP_SESSION_ID=id;process.env.PROOF_OR_STOP_AGENT=role;resetSessionIdForTest();}
try {
 writeFileSync(join(root,'.gitignore'),'owner-lease.json\n.proof-or-stop/runtime/\n');
 writeFileSync(join(root,'proof-or-stop.config.json'),JSON.stringify({scanRoot:'packages/main',rootDir:'src',storyDir:'.proof-or-stop/story/actives'}));
 execFileSync('git',['init','-q','-b','main'],{cwd:root});execFileSync('git',['config','user.name','Fixture'],{cwd:root});execFileSync('git',['config','user.email','fixture@example.invalid'],{cwd:root});
 execFileSync('git',['add','.'],{cwd:root});execFileSync('git',['commit','-qm','fixture baseline'],{cwd:root});execFileSync('git',['checkout','-qb','story/B-ab12'],{cwd:root});
 resetConfigCache();const store=new StoryStore(root);const now=new Date().toISOString();
 const story={storyId,name:'intent-proposal',title:'Intent proposal regression',description:'Owner applies reviewed intent proposal',type:'chore',phase:'PLAN',priority:'medium',createdAt:now,startedAt:now,endedAt:null,events:[]};
 store.writeStory(storyId,story);store.writeChecklist(storyId,{items:[{id:itemId,title:'Record intent',context:'Focused regression',status:'pending',files:{create:['scripts/benchmark/feasibility.mjs'],modify:[],test:['scripts/verify-benchmark-feasibility.mjs']}}]});
 process.chdir(root);session('fixture-owner');acquireOwnerLease(store.storyDirPath(storyId),{cwd:root,command:'fixture'});
 const proposalView=intent=>{
   const before=JSON.stringify(store.readChecklist(storyId));
   const result=spawnSync(process.execPath,[cli,'--root',root,'checklist_get',JSON.stringify({storyId,proposalFor:itemId,proposalIntent:intent})],{cwd:root,env:process.env,encoding:'utf8'});
   assert.equal(result.status,0,result.stderr);assert.equal(JSON.stringify(store.readChecklist(storyId)),before,'proposal digest view must not mutate checklist');
   const view=JSON.parse(result.stdout);assert.equal(view.approvalRequired,true);assert.equal(view.authority,'diagnostic_only');return view;
 };
 const proposal=proposalView(verificationIntent);const baseIntentHash=proposal.baseIntentHash;
 assert.equal(baseIntentHash,digestCanonicalJson(null));
 const args={storyId,itemId,verificationIntent,intentProposalApproval:{baseIntentHash,digest:proposal.digest,reason:'Apply the independently proposed complete intent after reviewing every declared condition.'}};
 const handlers=createChecklistHandlers({store,root,scanRoot:join(root,'packages/main')});
 const before=JSON.stringify(readOwnerLease(store.storyDirPath(storyId)));
 session('fixture-independent','proof-or-stop-verification-intent');
 assert.equal(resolveEffectiveOwnershipClass('checklist_update',args,storyId),'storyScopedMutating','role environment never exempts owner lease');
 assert.throws(()=>enforceStoryOwnerLeaseGate('checklist_update',args,store,{storyId,phase:'PLAN'},root),/owned|owner|lease/i);
 assert.throws(()=>handlers.checklist_update(args),/INTENT_PROPOSAL_ROLE_FORBIDDEN/);
 assert.equal(JSON.stringify(readOwnerLease(store.storyDirPath(storyId))),before);
 const foreign=spawnSync(process.execPath,[cli,'--root',root,'checklist_update',JSON.stringify(args)],{cwd:root,env:process.env,encoding:'utf8'});
 assert.notEqual(foreign.status,0);assert.match(foreign.stdout+foreign.stderr,/B-ab12 is owned by Proof-or-Stop session fixture-owner/);
 session('fixture-owner');
 for(const phase of ['INIT','INIT_CHECK','DEV','REVIEW','TEST','DONE']){
  store.writeStory(storyId,{...story,phase});
  assert.throws(()=>handlers.checklist_update(args),/\[verification_intent_writer_phase_invalid\]/);
 }
 store.writeStory(storyId,story);
 for(const bad of [{...args,intentProposalApproval:{...args.intentProposalApproval,digest:'0'.repeat(64)}},{...args,intentProposalApproval:{...args.intentProposalApproval,baseIntentHash:'0'.repeat(64)}},{...args,status:'done'}])assert.throws(()=>handlers.checklist_update(bad),/INTENT_PROPOSAL_(BINDING_INVALID|FIELDS_INVALID)/);
 const malformed=structuredClone(args);delete malformed.verificationIntent.happy[0].requirementSource;
 malformed.intentProposalApproval.digest=digestCanonicalJson({storyId,itemId,baseIntentHash,verificationIntent:malformed.verificationIntent});
 assert.throws(()=>handlers.checklist_update(malformed),/verification_intent_metadata_required/);
 assert.throws(()=>handlers.checklist_update({...args,intentProposalApproval:{...args.intentProposalApproval,reason:'short'}}),/INTENT_PROPOSAL_REASON_INVALID.*received 5/);
 session('fixture-independent');
 assert.throws(()=>handlers.checklist_update(args),/INTENT_PROPOSAL_OWNER_REQUIRED/);
 session('fixture-owner','proof-or-stop-verification-intent');
 const direct={storyId,itemId,verificationIntent};
 store.writeStory(storyId,{...story,phase:'INIT'});
 assert.throws(()=>handlers.checklist_update(direct),/verification_intent_writer_phase_invalid/);
 store.writeStory(storyId,story);
 const original=store.readChecklist(storyId);
 handlers.checklist_update(direct);
 assert.equal(store.readChecklist(storyId).items[0].verificationIntentAuthorship.kind,'dispatched_verification_intent');assert.equal(store.readChecklist(storyId).items[0].verificationIntentAuthorship.independentlyAttested,false);
 assert.deepEqual(store.readChecklist(storyId).items[0].verificationIntent.happy[0].plannedPathDeclarations,verificationIntent.happy[0].plannedPathDeclarations);
 store.writeChecklist(storyId,original);
 session('fixture-owner');
 const invoke=()=>new Promise((resolveRun,reject)=>{const child=spawn(process.execPath,[cli,'--root',root,'checklist_update',JSON.stringify(args)],{cwd:root,env:process.env});let out='';child.stdout.on('data',b=>out+=b);child.stderr.on('data',b=>out+=b);child.on('error',reject);child.on('close',status=>resolveRun({status,out}));});
 const attempts=await Promise.all([invoke(),invoke()]);
 assert.equal(attempts.filter(r=>r.status===0).length,1,'INTENT_OWNER_LEASE_CONFLICT: '+JSON.stringify(attempts));
 assert.match(attempts.find(r=>r.status!==0).out,/INTENT_PROPOSAL_BINDING_INVALID|lock.*timeout|timed out.*lock/i,'concurrent duplicate must fail stale or explicit lock contention');
 assert.equal(readOwnerLease(store.storyDirPath(storyId)).sessionId,'fixture-owner');
 const saved=store.readChecklist(storyId);assert.deepEqual(saved.items[0].verificationIntent.happy[0].plannedPathDeclarations,verificationIntent.happy[0].plannedPathDeclarations);
 assert.equal(saved.items[0].verificationIntentAuthorship.intentDigest,acceptanceIntentHash(saved.items[0].verificationIntent));
 assert(saved.auditLog.some(row=>row.reason.includes(args.intentProposalApproval.digest)));
 assert.equal(saved.items[0].verificationIntentAuthorship.kind,'owner_applied_proposal');assert.equal(saved.items[0].verificationIntentAuthorship.independentlyAttested,false);assert.equal(saved.items[0].verificationIntentAuthorship.proposalDigest,args.intentProposalApproval.digest);
 assert(store.readProcessEvents(storyId).some(row=>row.action==='verification_intent_applied' && row.authorship?.proposalDigest===args.intentProposalApproval.digest));
 assert.throws(()=>handlers.checklist_update(args),/INTENT_PROPOSAL_BINDING_INVALID/,'stale base is rejected even for owner');
 // Event logging failure must not report a false write failure or skip metadata commit.
 const replacement=structuredClone(verificationIntent);replacement.edge[0].desc+=' Preserve attribution when ancillary logging fails.';
 const currentHash=digestCanonicalJson(saved.items[0].verificationIntent);
 const eventArgs={storyId,itemId,verificationIntent:replacement,intentProposalApproval:{baseIntentHash:currentHash,digest:digestCanonicalJson({storyId,itemId,baseIntentHash:currentHash,verificationIntent:replacement}),reason:'Apply a fixture proposal to exercise ancillary event log failure recovery.'}};
 const headBefore=execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim();
 const appendEvent=store.appendProcessEvent;const warn=console.warn;const warnings=[];
 try{store.appendProcessEvent=()=>{throw new Error('FIXTURE_EVENT_LOG_UNAVAILABLE');};console.warn=(...values)=>warnings.push(values.join(' '));
   assert.match(handlers.checklist_update(eventArgs),/owner-approved proposal applied/);
 }finally{store.appendProcessEvent=appendEvent;console.warn=warn;}
 assert(warnings.some(message=>message.includes('FIXTURE_EVENT_LOG_UNAVAILABLE')));
 assert.equal(store.readChecklist(storyId).items[0].verificationIntent.edge[0].desc,replacement.edge[0].desc);
 assert.notEqual(execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),headBefore,'ancillary event failure must still commit');
 store.writeChecklist(storyId,saved);
 // Real CLI replan admission must match the existing INIT-only removal handler.
 store.writeStory(storyId,{...story,phase:'INIT'});
 const removeArgs={storyId,itemId,disposition:'accept',justification:'Disposable fixture checks the supported INIT consolidation path.'};
 for(const role of ['proof-or-stop-review-story-init','proof-or-stop-product-reviewer']){
   session('fixture-owner',role);
   assert.throws(()=>handlers.checklist_remove({...removeArgs,actor:'main-agent'}),/agent_dispatch_identity_conflict|agent_dispatch_mutation_denied|init_reviewer_checklist_mutation_blocked/);
   const denied=spawnSync(process.execPath,[cli,'--root',root,'checklist_remove',JSON.stringify(removeArgs)],{cwd:root,env:process.env,encoding:'utf8'});
   assert.notEqual(denied.status,0);assert.match(denied.stdout+denied.stderr,/agent_dispatch_identity_conflict|agent_dispatch_mutation_denied|init_reviewer_checklist_mutation_blocked/);
 }
 session('fixture-owner');
 assert.throws(()=>handlers.checklist_remove({...removeArgs,agent:'proof-or-stop-product-reviewer'}),/agent_dispatch_identity_conflict|agent_dispatch_mutation_denied|init_reviewer_checklist_mutation_blocked/);
 const remove=spawnSync(process.execPath,[cli,'--root',root,'checklist_remove',JSON.stringify({storyId,itemId,disposition:'accept',justification:'Disposable fixture checks the supported INIT consolidation path.'})],{cwd:root,env:process.env,encoding:'utf8'});
 assert.equal(remove.status,0,'INIT_REMOVAL_UNREACHABLE: '+remove.stdout+remove.stderr);
 assert.equal(store.readChecklist(storyId).items.length,0);assert.equal(store.readChecklist(storyId).auditLog.at(-1).agent,'main-agent');
 store.writeStory(storyId,story);store.writeChecklist(storyId,saved);
 const late=spawnSync(process.execPath,[cli,'--root',root,'checklist_remove',JSON.stringify({storyId,itemId,disposition:'accept',justification:'Must be refused after the INIT phase.'})],{cwd:root,env:process.env,encoding:'utf8'});
 assert.notEqual(late.status,0);assert.match(late.stdout+late.stderr,/PLAN phase does not allow removing|not available.*PLAN|Allowed phases: INIT/);
 // A genuine signed amendment must not allow a foreign role to create a revision.
 store.writeStory(storyId,{...story,phase:'DEV'});
 const addition={edge:[{id:'SIGNED-EDGE',desc:'Additional signed boundary assertion',type:'cli',priority:'must'}]};
 handlers.verification_intent_append({storyId,itemId,expectedIntentHash:acceptanceIntentHash(saved.items[0].verificationIntent),reason:'Append a signed acceptance condition and clear its superseded proposal attribution.',addition});
 const amended=store.readChecklist(storyId);
 assert.equal(amended.items[0].verificationIntentAuthorship,undefined,'official semantic append must clear proposal attribution');
 store.writeStory(storyId,story);
 session('fixture-independent','proof-or-stop-verification-intent');
 const revised=structuredClone(amended.items[0].verificationIntent);revised.edge[0].desc+=' Updated boundary.';Object.assign(revised.edge.at(-1),{scope:'focused',expectation:'absolute_pass',requirementSource:'story'});
 assert.throws(()=>handlers.checklist_update({storyId,itemId,verificationIntent:revised}),/AMENDMENT_OWNER_REQUIRED/);
 assert.deepEqual(store.readChecklist(storyId),amended,'refused signed revision must not persist');
 session('fixture-owner');
 const applyOwnerIntent=intent=>{
   const view=proposalView(intent);
   const payload={storyId,itemId,verificationIntent:intent,intentProposalApproval:{baseIntentHash:view.baseIntentHash,digest:view.digest,reason:'Apply independently prepared classifications through the documented owner proposal route.'}};
   const run=spawnSync(process.execPath,[cli,'--root',root,'checklist_update',JSON.stringify(payload)],{cwd:root,env:process.env,encoding:'utf8'});
   assert.equal(run.status,0,run.stdout+run.stderr);
 };
 applyOwnerIntent(revised);
 const revisedItem=store.readChecklist(storyId).items[0];
 assert.equal(revisedItem.verificationIntentAmendments.length,amended.items[0].verificationIntentAmendments.length+1);
 assert.equal(revisedItem.verificationIntentAmendments.at(-1).afterHash,revisedItem.verificationIntentAuthorship.intentDigest);
 assert.equal(revisedItem.verificationIntentAuthorship.intentDigest,acceptanceIntentHash(revisedItem.verificationIntent));
 assert.equal('sessionId' in revisedItem.verificationIntentAuthorship,false);
 applyOwnerIntent(revisedItem.verificationIntent);
 assert.equal(store.readChecklist(storyId).items[0].verificationIntentAmendments.length,revisedItem.verificationIntentAmendments.length,'semantic no-op must not create another signed revision');

 session('fixture-owner');store.writeStory(storyId,{...story,phase:'DEV'});
 handlers.verification_intent_append({storyId,itemId,expectedIntentHash:acceptanceIntentHash(store.readChecklist(storyId).items[0].verificationIntent),reason:'Append a real signed acceptance condition and clear superseded attribution.',addition:{edge:[{id:'APPENDED-EDGE',desc:'Another mandatory acceptance condition for the fixture',type:'cli',priority:'must'}]}});
 assert.equal(store.readChecklist(storyId).items[0].verificationIntentAuthorship,undefined,'semantic append must clear old owner proposal attribution');
 const recovery=JSON.parse(handlers.verification_intent_recover({storyId}));
 handlers.verification_intent_recover({storyId,expectedCheckpointDigest:recovery.expectedCheckpointDigest,reason:'Restore the exact signed intent and matching attribution checkpoint.',apply:true});
 assert.equal(store.readChecklist(storyId).items[0].verificationIntentAuthorship,undefined,'exact recovery restores the matching absent marker');
 console.log('INTENT_OWNER_LEASE_PASS: real CLI owner application; foreign role refusal; exact proposal, phase and stale-base checks');
} finally {process.chdir(cwd);for(const key of Object.keys(process.env))if(!(key in env))delete process.env[key];Object.assign(process.env,env);resetSessionIdForTest();rmSync(root,{recursive:true,force:true});}
