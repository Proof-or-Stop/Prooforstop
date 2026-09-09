import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {execFileSync,spawnSync} from 'node:child_process';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {StoryStore} from '../../packages/main/dist/core/store.js';
import {createChecklistHandlers} from '../../packages/main/dist/handlers/checklist.js';
import {acquireOwnerLease} from '../../packages/main/dist/core/story-owner-lease.js';
import {digestCanonicalJson} from '../../packages/main/dist/core/digest.js';
import {resetConfigCache} from '../../packages/main/dist/core/config.js';
const root=mkdtempSync(join(tmpdir(),'acceptance-erasure-')),storyId='B-erasure-lab';
const cli=resolve(import.meta.dirname,'../../packages/main/dist/cli.js');
const git=args=>execFileSync('git',args,{cwd:root,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
process.env.PROOF_OR_STOP_SESSION_ID='erasure-owner';
try{
 mkdirSync(join(root,'src'));writeFileSync(join(root,'src/subject.js'),'export const x=true;\n');
 writeFileSync(join(root,'proof-or-stop.config.json'),JSON.stringify({scanRoot:'.',rootDir:'src',storyDir:'.proof-or-stop/story/actives'}));
 writeFileSync(join(root,'.gitignore'),'.proof-or-stop/runtime/\n.proof-or-stop/locks/\n');
 git(['init','-q','-b','work']);git(['config','user.name','Lab fixture']);git(['config','user.email','lab@example.test']);git(['add','.']);git(['commit','-qm','fixture']);git(['branch','main']);const mainBefore=git(['rev-parse','main']);resetConfigCache();
 const store=new StoryStore(root);store.writeStory(storyId,{storyId,name:'erasure',title:'Preserve acceptance',phase:'DEV',type:'chore',priority:'medium',createdAt:new Date().toISOString()});
 const old={id:'CHK-001',title:'Coverage',context:'Preserve signed history',status:'in_progress',startTime:null,endTime:null,files:{modify:['src/subject.js'],create:[],test:[]},verificationIntent:{happy:[{id:'OLD',desc:'Original assertion',type:'cli',priority:'must'}],edge:[],adversarial:[]}};
 store.writeChecklist(storyId,{items:[old]});acquireOwnerLease(store.storyDirPath(storyId),{command:'fixture',cwd:root});
 const handler=createChecklistHandlers({store,root,scanRoot:root});handler.verification_intent_append({storyId,itemId:'CHK-001',expectedIntentHash:digestCanonicalJson(old.verificationIntent),reason:'Add a required regression inside the existing acceptance scope for this private fixture.',addition:{edge:[{id:'NEW',desc:'A newly required boundary must remain required',type:'cli',priority:'must'}]}});
 const pristine=store.readChecklist(storyId);
 // The two losses are the exact previously reproduced defect; no real Story is touched.
 store.writeJson(storyId,'checklist.json',{items:[old]});rmSync(join(root,'.git/proof-or-stop-intent-checkpoints'),{recursive:true,force:true});
 assert.throws(()=>store.readChecklist(storyId),/AMENDMENT_CHECKPOINT_PROJECTION_MISMATCH/,'COMBINED_ACCEPTANCE_ERASURE_ACCEPTED: removing the projection history and local checkpoint mirror must not erase the acceptance obligation');
 const inspect=handler.verification_intent_recover({storyId});assert.match(inspect,/checkpoint|digest/i);
 const apply=spawnSync(process.execPath,[cli,'verification_intent_recover',JSON.stringify({storyId,apply:true,expectedCheckpointDigest:digestCanonicalJson(pristine),reason:'Restore the anchored signed acceptance snapshot after the two isolated loss injections.'})],{cwd:root,encoding:'utf8',timeout:30000,env:process.env});assert.equal(apply.status,0,apply.stdout+apply.stderr);assert.deepEqual(store.readChecklist(storyId),pristine);
 git(['pack-refs','--all']);git(['gc','--prune=now']);
 store.writeJson(storyId,'checklist.json',{items:[old]});
 assert.throws(()=>store.readChecklist(storyId),/AMENDMENT_CHECKPOINT_PROJECTION_MISMATCH/,'Packed refs and normal GC must retain the required signed history');
 handler.verification_intent_recover({storyId,apply:true,expectedCheckpointDigest:digestCanonicalJson(pristine),reason:'Restore the same authoritative snapshot after packed-ref and garbage collection controls.'});
 assert.deepEqual(store.readChecklist(storyId),pristine);assert.equal(git(['rev-parse','main']),mainBefore,'Checkpoint anchoring must not move main');
 console.log('ANCHORED_ACCEPTANCE_ERASURE_GREEN: dual loss refused; actual owner CLI recovered; packed refs and GC retain evidence; main unchanged');
}finally{rmSync(root,{recursive:true,force:true});resetConfigCache();}
