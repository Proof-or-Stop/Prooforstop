// Disposable integration fixture; production producers issue all signed evidence.
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,writeFileSync,rmSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
const root=mkdtempSync(join(tmpdir(),'pos-transaction-v3-'));
const git=args=>execFileSync('git',args,{cwd:root,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
const sha=b=>createHash('sha256').update(b).digest('hex');
const scenario=process.argv.find(x=>x.startsWith('--scenario='))?.slice(11)||'late-write';
try{
 if(scenario==='late-write'){
  const {commitImmutableMetadataTree}=await import(resolve('packages/main/dist/core/done-prepare-generated-metadata.js'));
  git(['init','-q','-b','main']);git(['config','user.name','Lab Proof']);git(['config','user.email','lab@example.invalid']);
  writeFileSync(join(root,'metadata.json'),'before');git(['add','.']);git(['commit','-qm','baseline']);const before=git(['rev-parse','HEAD']);
  writeFileSync(join(root,'metadata.json'),'owned');
  const result=commitImmutableMetadataTree({root,gitCwd:root,paths:['metadata.json'],verifiedHashes:new Map([['metadata.json',sha('owned')]]),message:'owned transaction',testHooks:{beforeCasUpdate(){writeFileSync(join(root,'metadata.json'),'FOREIGN');}}});
  console.log(JSON.stringify({scenario,result,head:git(['rev-parse','HEAD']),before,bytes:readFileSync(join(root,'metadata.json'),'utf8')}));
  assert.equal(result.ok,false,'LATE_FOREIGN_WRITE_MUST_REFUSE');assert.equal(git(['rev-parse','HEAD']),before);assert.equal(readFileSync(join(root,'metadata.json'),'utf8'),'FOREIGN');
 }else if(scenario==='scope-write-failure'){
  const {StoryStore}=await import(resolve('packages/main/dist/core/store.js'));
  const {createProofStoryHandlers}=await import(resolve('packages/main/dist/handlers/proofstory.js'));
  const store=new StoryStore(root),storyId='B-atomic',now=new Date().toISOString();
  store.writeStory(storyId,{storyId,name:storyId,title:'Atomic withdrawal fixture',description:'Disposable authorized Lab fixture',type:'feature',phase:'DEV',priority:'high',createdAt:now,startedAt:now,endedAt:null});
  store.writeChecklist(storyId,{items:['CHK-1','CHK-2'].map(id=>({id,title:id,status:'done',startTime:null,endTime:null}))});
  store.writeProofStoryContract(storyId,{schemaVersion:'proofstory.contract.v1',storyId,diagnosticOnly:false,hardeningLevel:'standard',triggerReasons:[],acceptanceBindings:['AB-1','AB-2'].map((id,i)=>({id,checklistRefs:['CHK-'+(i+1)],verificationIntentRefs:['CHK-'+(i+1)+':happy:0'],milestoneIds:[]})),diagnosticGaps:[],createdAt:now,updatedAt:now});
  git(['init','-q','-b','story/'+storyId]);git(['config','user.name','Lab']);git(['config','user.email','lab@example.invalid']);
  const initial=store.readChecklist(storyId);initial.items[1].verificationIntent={happy:[{id:'initial-check',desc:'Original bounded acceptance check',type:'cli',priority:'must'}]};store.writeChecklist(storyId,initial);
  git(['add','.']);git(['commit','-qm','seed amendment fixture']);
  const {acquireOwnerLease}=await import(resolve('packages/main/dist/core/story-owner-lease.js'));
  const {createChecklistHandlers}=await import(resolve('packages/main/dist/handlers/checklist.js'));
  const {acceptanceIntentHash}=await import(resolve('packages/main/dist/core/verification-intent-amendment.js'));
  acquireOwnerLease(store.storyDirPath(storyId),{command:'verification_intent_append',cwd:root});
  const previousCwd=process.cwd();
  try {process.chdir(root);createChecklistHandlers({root,scanRoot:root,store}).verification_intent_append({storyId,itemId:'CHK-2',expectedIntentHash:acceptanceIntentHash(initial.items[1].verificationIntent),reason:'Add an explicit signed acceptance witness for rollback compatibility',addition:{edge:[{id:'extra-check',desc:'Additional bounded compatibility check',type:'cli',priority:'must'}]}});}finally{process.chdir(previousCwd);}
  assert.equal(store.readChecklist(storyId).items[1].verificationIntentAmendments.length,1,'Fixture must have an actual signed amendment and checkpoint');
  const {readIntentCheckpoint}=await import(resolve('packages/main/dist/core/verification-intent-checkpoint.js'));
  const checkpointBefore=readIntentCheckpoint(storyId,store.storyDirPath(storyId));
  const checkpointRefs=git(['for-each-ref','--format=%(refname)','refs/proof-or-stop/intent-checkpoints']).split('\n').filter(Boolean);assert.equal(checkpointRefs.length,1);
  const anchorBefore=git(['rev-parse',checkpointRefs[0]]);
  const historyBefore=git(['rev-list',anchorBefore]);
  const before={decision:store.readScopeShrinkageDecision(storyId),checklist:store.readChecklist(storyId),contract:store.readProofStoryContract(storyId)};
  const original=store.writeChecklist.bind(store);store.writeChecklist=(...args)=>{original(...args);throw new Error('INJECTED_AFTER_CHECKLIST');};
  assert.throws(()=>createProofStoryHandlers({root,scanRoot:root,store}).scope_shrinkage_decision_set({storyId,decision:'confirmed',userConfirmed:true,reason:'Authorized bounded fixture withdrawal',approvedBy:'fixture-operator',withdrawnChecklistItemRefs:['CHK-2'],withdrawnAcceptanceBindingRefs:['AB-2']}),/INJECTED_AFTER_CHECKLIST/);
  const after={decision:store.readScopeShrinkageDecision(storyId),checklist:store.readChecklist(storyId),contract:store.readProofStoryContract(storyId)};
  console.log(JSON.stringify({scenario,before,after}));assert.deepEqual(after,before,'SCOPE_MULTIFILE_FAILURE_MUST_BE_ALL_BEFORE');
  const checkpointAfter=readIntentCheckpoint(storyId,store.storyDirPath(storyId));assert.equal(checkpointAfter.generation,checkpointBefore.generation+2,'Rollback must append a forward compensation generation');assert.deepEqual(checkpointAfter.data,before.checklist);assert.equal(git(['rev-list',anchorBefore]),historyBefore,'Old signed checkpoint history must remain byte-identical');assert.equal(git(['merge-base','--is-ancestor',anchorBefore,checkpointRefs[0]]),'');console.log('SIGNED_SCOPE_COMPENSATION_GREEN');
 }
 console.log('TRANSACTION_V3_GREEN '+scenario);
}finally{rmSync(root,{recursive:true,force:true});}
