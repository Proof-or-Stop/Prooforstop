import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,readdirSync,chmodSync,existsSync} from 'node:fs';
import {execFileSync,spawnSync} from 'node:child_process';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
const runtime=process.env.CHECKPOINT_TEST_RUNTIME??resolve(import.meta.dirname,'../..');
const {StoryStore}=await import(runtime+'/packages/main/dist/core/store.js');
const {createChecklistHandlers}=await import(runtime+'/packages/main/dist/handlers/checklist.js');
const {acquireOwnerLease}=await import(runtime+'/packages/main/dist/core/story-owner-lease.js');
const {digestCanonicalJson}=await import(runtime+'/packages/main/dist/core/digest.js');
const {resetConfigCache}=await import(runtime+'/packages/main/dist/core/config.js');
const {readIntentCheckpoint,writeIntentCheckpoint}=await import(runtime+'/packages/main/dist/core/verification-intent-checkpoint.js');
const {IntentAmendmentIntegrityError}=await import(runtime+'/packages/main/dist/core/verification-intent-amendment.js');
const storyId='B-anchor-controls';process.env.PROOF_OR_STOP_SESSION_ID='anchor-controls-owner';
const results=[];
function run(name,fn,backend='files'){
 const root=mkdtempSync(join(tmpdir(),'anchor-controls-'));const git=(args,input)=>execFileSync('/usr/bin/git',args,{cwd:root,input,encoding:'utf8',stdio:['pipe','pipe','pipe']}).trim();
 const envPath=process.env.PATH;
 try{
  mkdirSync(join(root,'src'));writeFileSync(join(root,'src/subject.js'),'export const x=true;\n');writeFileSync(join(root,'proof-or-stop.config.json'),JSON.stringify({scanRoot:'.',rootDir:'src',storyDir:'.proof-or-stop/story/actives'}));writeFileSync(join(root,'.gitignore'),'.proof-or-stop/runtime/\n.proof-or-stop/locks/\n');
  git(['init','-q','-b','work','--ref-format='+backend]);git(['config','user.name','Private audit fixture']);git(['config','user.email','audit@example.test']);git(['add','.']);git(['commit','-qm','fixture']);git(['branch','main']);const main=git(['rev-parse','main']);resetConfigCache();
  const store=new StoryStore(root);store.writeStory(storyId,{storyId,name:'anchor',title:'Preserve signed acceptance',phase:'DEV',type:'chore',priority:'medium',createdAt:new Date().toISOString()});
  const old={id:'CHK-001',title:'Coverage',context:'Keep every required boundary',status:'in_progress',startTime:null,endTime:null,files:{modify:['src/subject.js'],create:[],test:[]},verificationIntent:{happy:[{id:'OLD',desc:'Original assertion',type:'cli',priority:'must'}],edge:[],adversarial:[]}};
  store.writeChecklist(storyId,{items:[old]});acquireOwnerLease(store.storyDirPath(storyId),{command:'fixture',cwd:root});const handler=createChecklistHandlers({store,root,scanRoot:root});
  const append=id=>{const data=store.readChecklist(storyId);return handler.verification_intent_append({storyId,itemId:'CHK-001',expectedIntentHash:digestCanonicalJson(data.items[0].verificationIntent),reason:'Add the independently verified required boundary within this private fixture scope.',addition:{edge:[{id,desc:'Preserve required boundary '+id,type:'cli',priority:'must'}]}});};
  const ref='refs/proof-or-stop/intent-checkpoints/'+digestCanonicalJson(storyId),mirror=join(root,'.git/proof-or-stop-intent-checkpoints',digestCanonicalJson(storyId));
  const recover=()=>handler.verification_intent_recover({storyId,apply:true,expectedCheckpointDigest:readIntentCheckpoint(storyId,root).dataDigest,reason:'Recover the signed authoritative snapshot after a bounded local fault injection.'});
  append('ONE');fn({root,git,store,handler,old,append,ref,mirror,recover});assert.equal(git(['rev-parse','main']),main,'Main fixture branch must remain unchanged');results.push({name,backend,passed:true});console.log('PASS',name);
 }catch(e){results.push({name,backend,passed:false,error:String(e),code:e.code??null});console.log('FAIL',name,String(e));}finally{process.env.PATH=envPath;try{chmodSync(join(root,'.git/proof-or-stop-intent-checkpoints',digestCanonicalJson(storyId)),0o700);}catch{}rmSync(root,{recursive:true,force:true});resetConfigCache();}
}

const reason='Recover the complete signed history after a controlled private-fixture fault.';
const inspect=f=>JSON.parse(f.handler.verification_intent_recover({storyId}));
const apply=(f,digest)=>f.handler.verification_intent_recover({storyId,apply:true,expectedCheckpointDigest:digest,reason});
const truncate=f=>{const tip=f.git(['rev-parse',f.ref]);const tree=f.git(['rev-parse',tip+'^{tree}']);const bad=f.git(['commit-tree',tree],'Prior experimental parentless anchor\n');f.git(['update-ref',f.ref,bad,tip]);return bad;};
run('owner rebuilds prior truncated anchor from exact complete signed mirror',f=>{
 f.append('TWO');const snapshot=f.store.readChecklist(storyId),bad=truncate(f);
 assert.throws(()=>readIntentCheckpoint(storyId,f.root),/AMENDMENT_CHECKPOINT_HISTORY_GAP/);
 const plan=inspect(f);assert.equal(f.git(['rev-parse',f.ref]),bad,'Inspection must not mutate anchor');assert.equal(plan.writes,0);
 apply(f,plan.expectedCheckpointDigest);assert.equal(Number(f.git(['rev-list','--count',f.ref])),2);assert.deepEqual(f.store.readChecklist(storyId),snapshot);
});
run('owner quarantines corrupt mirror and preserves original bytes',f=>{
 f.append('TWO');const snapshot=f.store.readChecklist(storyId);const file=join(f.mirror,'000000000001.json');const bad=JSON.parse(readFileSync(file,'utf8'));bad.data.items[0].title='Corrupted mirror only';const bytes=JSON.stringify(bad);writeFileSync(file,bytes);
 assert.throws(()=>readIntentCheckpoint(storyId,f.root),/AMENDMENT_CHECKPOINT_MIRROR_CONFLICT/);const plan=inspect(f);assert.equal(readFileSync(file,'utf8'),bytes,'Inspection must retain bytes');
 apply(f,plan.expectedCheckpointDigest);assert.deepEqual(f.store.readChecklist(storyId),snapshot);const q=readdirSync(join(f.mirror,'..')).filter(n=>n.startsWith(digestCanonicalJson(storyId)+'.quarantine-'));assert.equal(q.length,1);assert.equal(readFileSync(join(f.mirror,'..',q[0],'000000000001.json'),'utf8'),bytes);
 f.append('THREE');assert.equal(readIntentCheckpoint(storyId,f.root).generation,3);
});
run('stale digest cannot repair corrupt storage',f=>{
 const file=join(f.mirror,'000000000001.json');writeFileSync(file,'{broken');assert.throws(()=>apply(f,'wrong'),/AMENDMENT_CHECKPOINT_STALE_OR_MISSING/);assert.equal(readFileSync(file,'utf8'),'{broken');
 const plan=inspect(f);apply(f,plan.expectedCheckpointDigest);assert.equal(readIntentCheckpoint(storyId,f.root).generation,1);
});
run('signed newer mirror cannot be quarantined as corruption',f=>{
 const first=f.git(['rev-parse',f.ref]);f.append('TWO');f.git(['update-ref',f.ref,first]);writeFileSync(join(f.mirror,'000000000001.json'),'{broken');assert.throws(()=>inspect(f),/AMENDMENT_CHECKPOINT_ROLLBACK/);
});
run('missing signed generation cannot be invented for old truncated anchor',f=>{
 f.append('TWO');truncate(f);rmSync(join(f.mirror,'000000000001.json'));assert.throws(()=>inspect(f),/AMENDMENT_CHECKPOINT_HISTORY_GAP/);
});
run('foreign session and terminal owner remain refused',f=>{
 writeFileSync(join(f.mirror,'000000000001.json'),'{broken');const session=process.env.PROOF_OR_STOP_SESSION_ID;
 const child=spawnSync(process.execPath,['--input-type=module','-e',`import {StoryStore} from ${JSON.stringify(runtime+'/packages/main/dist/core/store.js')};import {createChecklistHandlers} from ${JSON.stringify(runtime+'/packages/main/dist/handlers/checklist.js')};const root=${JSON.stringify(f.root)};try{createChecklistHandlers({store:new StoryStore(root),root,scanRoot:root}).verification_intent_recover({storyId:${JSON.stringify(storyId)}});process.exitCode=2;}catch(e){console.log(String(e));process.exitCode=String(e).includes('AMENDMENT_OWNER_REQUIRED')?0:3;}`],{cwd:f.root,encoding:'utf8',env:{...process.env,PROOF_OR_STOP_SESSION_ID:'foreign-owner'}});assert.equal(child.status,0,child.stdout+child.stderr);
 const story=f.store.readStory(storyId);f.store.writeStory(storyId,{...story,phase:'DONE'});assert.throws(()=>inspect(f),/AMENDMENT_RECOVERY_ACTIVE_STORY_REQUIRED/);
});
const output=process.env.FIVE_ITEM_PROOF_OUTPUT;if(output){mkdirSync(output,{recursive:true});writeFileSync(join(output,'checkpoint-owner-recovery.json'),JSON.stringify(results,null,2)+'\n');}assert.ok(results.every(r=>r.passed),'CHECKPOINT_GOVERNED_RECOVERY_GAPS: available signed history must have an owner repair path');console.log('CHECKPOINT_OWNER_RECOVERY_GREEN',results.length);
