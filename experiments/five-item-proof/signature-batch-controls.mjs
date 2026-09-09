import childProcess from 'node:child_process';import {syncBuiltinESMExports} from 'node:module';
const originalExec=childProcess.execFileSync;let keyLookups=0;childProcess.execFileSync=function(file,args,...rest){if(file==='git'&&args?.[0]==='rev-parse'&&args?.[1]==='--git-common-dir')keyLookups++;return originalExec.call(this,file,args,...rest);};syncBuiltinESMExports();
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


const {assertIntentAmendments}=await import(runtime+'/packages/main/dist/core/verification-intent-amendment.js');
run('every signature and binding retained with bounded key lookup',f=>{
 for(const id of ['TWO','THREE','FOUR','FIVE'])f.append(id);
 const item=f.store.readChecklist(storyId).items[0];keyLookups=0;
 assertIntentAmendments(item,storyId,f.root);const lookups=keyLookups;
 for(let i=0;i<5;i++){const bad=structuredClone(item);bad.verificationIntentAmendments[i].reason+=' altered';assert.throws(()=>assertIntentAmendments(bad,storyId,f.root),/AMENDMENT_INVALID_SIGNATURE_OR_BINDING/);}
 const bad=structuredClone(item);bad.verificationIntent.happy[0].desc+=' changed';assert.throws(()=>assertIntentAmendments(bad,storyId,f.root),/AMENDMENT_CURRENT_INTENT_MISMATCH/);
 console.log('AMENDMENT_KEY_LOOKUPS',lookups);assert.ok(lookups<=2,'Repeated signed rows must share one fresh key read plus end-of-batch revalidation; observed '+lookups);
});
const output=process.env.FIVE_ITEM_PROOF_OUTPUT;if(output){mkdirSync(output,{recursive:true});writeFileSync(join(output,'signature-batch-controls.json'),JSON.stringify(results,null,2)+'\n');}assert.ok(results.every(r=>r.passed),'SIGNATURE_BATCH_KEY_LOOKUP_GAP');console.log('SIGNATURE_BATCH_CONTROLS_GREEN');
