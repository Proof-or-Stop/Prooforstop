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
import {digestCanonicalJson} from '../packages/main/dist/core/digest.js';
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
 writeFileSync(join(root,'proof-or-stop.config.json'),JSON.stringify({scanRoot:'packages/main',rootDir:'src',storyDir:'.proof-or-stop/story/actives'}));
 execFileSync('git',['init','-q','-b','main'],{cwd:root});execFileSync('git',['config','user.name','Fixture'],{cwd:root});execFileSync('git',['config','user.email','fixture@example.invalid'],{cwd:root});
 execFileSync('git',['add','.'],{cwd:root});execFileSync('git',['commit','-qm','fixture baseline'],{cwd:root});
 resetConfigCache();const store=new StoryStore(root);const now=new Date().toISOString();
 const story={storyId,name:'intent-proposal',title:'Intent proposal regression',description:'Owner applies reviewed intent proposal',type:'chore',phase:'PLAN',priority:'medium',createdAt:now,startedAt:now,endedAt:null,events:[]};
 store.writeStory(storyId,story);store.writeChecklist(storyId,{items:[{id:itemId,title:'Record intent',context:'Focused regression',status:'pending',files:{create:['scripts/benchmark/feasibility.mjs'],modify:[],test:['scripts/verify-benchmark-feasibility.mjs']}}]});
 process.chdir(root);session('fixture-owner');acquireOwnerLease(store.storyDirPath(storyId),{cwd:root,command:'fixture'});
 const baseIntentHash=digestCanonicalJson(null);
 const args={storyId,itemId,verificationIntent,intentProposalApproval:{baseIntentHash,digest:digestCanonicalJson({storyId,itemId,baseIntentHash,verificationIntent}),reason:'Apply the independently proposed complete intent after reviewing every declared condition.'}};
 const handlers=createChecklistHandlers({store,root,scanRoot:join(root,'packages/main')});
 const before=JSON.stringify(readOwnerLease(store.storyDirPath(storyId)));
 session('fixture-independent','proof-or-stop-verification-intent');
 assert.equal(resolveEffectiveOwnershipClass('checklist_update',args,storyId),'storyScopedMutating','role environment never exempts owner lease');
 assert.throws(()=>enforceStoryOwnerLeaseGate('checklist_update',args,store,{storyId,phase:'PLAN'},root),/owned|owner|lease/i);
 assert.throws(()=>handlers.checklist_update(args),/INTENT_PROPOSAL_OWNER_REQUIRED/);
 assert.equal(JSON.stringify(readOwnerLease(store.storyDirPath(storyId))),before);
 const foreign=spawnSync(process.execPath,[cli,'--root',root,'checklist_update',JSON.stringify(args)],{cwd:root,env:process.env,encoding:'utf8'});
 assert.notEqual(foreign.status,0);assert.match(foreign.stdout+foreign.stderr,/owner|lease/i);
 session('fixture-owner');
 for(const phase of ['INIT','INIT_CHECK','DEV','REVIEW','TEST','DONE']){
  store.writeStory(storyId,{...story,phase});
  assert.throws(()=>handlers.checklist_update(args),/\[verification_intent_writer_phase_invalid\]/);
 }
 store.writeStory(storyId,story);
 for(const bad of [{...args,intentProposalApproval:{...args.intentProposalApproval,digest:'0'.repeat(64)}},{...args,intentProposalApproval:{...args.intentProposalApproval,baseIntentHash:'0'.repeat(64)}},{...args,status:'done'}])assert.throws(()=>handlers.checklist_update(bad),/INTENT_PROPOSAL_(BINDING_INVALID|OWNER_REQUIRED)/);
 const invoke=()=>new Promise((resolveRun,reject)=>{const child=spawn(process.execPath,[cli,'--root',root,'checklist_update',JSON.stringify(args)],{cwd:root,env:process.env});let out='';child.stdout.on('data',b=>out+=b);child.stderr.on('data',b=>out+=b);child.on('error',reject);child.on('close',status=>resolveRun({status,out}));});
 const attempts=await Promise.all([invoke(),invoke()]);
 assert.equal(attempts.filter(r=>r.status===0).length,1,'INTENT_OWNER_LEASE_CONFLICT: '+JSON.stringify(attempts));
 assert.match(attempts.find(r=>r.status!==0).out,/INTENT_PROPOSAL_BINDING_INVALID/,'concurrent duplicate must fail stale, not contend for git index');
 assert.equal(readOwnerLease(store.storyDirPath(storyId)).sessionId,'fixture-owner');
 const saved=store.readChecklist(storyId);assert.deepEqual(saved.items[0].verificationIntent.happy[0].plannedPathDeclarations,verificationIntent.happy[0].plannedPathDeclarations);
 assert(saved.auditLog.some(row=>row.reason.includes(args.intentProposalApproval.digest)));
 assert.throws(()=>handlers.checklist_update(args),/INTENT_PROPOSAL_BINDING_INVALID/,'stale base is rejected even for owner');
 // Real CLI replan admission must match the existing INIT-only removal handler.
 store.writeStory(storyId,{...story,phase:'INIT'});
 const remove=spawnSync(process.execPath,[cli,'--root',root,'checklist_remove',JSON.stringify({storyId,itemId,disposition:'accept',justification:'Disposable fixture checks the supported INIT consolidation path.'})],{cwd:root,env:process.env,encoding:'utf8'});
 assert.equal(remove.status,0,'INIT_REMOVAL_UNREACHABLE: '+remove.stdout+remove.stderr);
 assert.equal(store.readChecklist(storyId).items.length,0);
 store.writeStory(storyId,story);store.writeChecklist(storyId,saved);
 const late=spawnSync(process.execPath,[cli,'--root',root,'checklist_remove',JSON.stringify({storyId,itemId,disposition:'accept',justification:'Must be refused after the INIT phase.'})],{cwd:root,env:process.env,encoding:'utf8'});
 assert.notEqual(late.status,0);assert.match(late.stdout+late.stderr,/PLAN phase does not allow removing|not available.*PLAN|Allowed phases: INIT/);
 console.log('INTENT_OWNER_LEASE_PASS: real CLI owner application; foreign role refusal; exact proposal, phase and stale-base checks');
} finally {process.chdir(cwd);for(const key of Object.keys(process.env))if(!(key in env))delete process.env[key];Object.assign(process.env,env);resetSessionIdForTest();rmSync(root,{recursive:true,force:true});}
