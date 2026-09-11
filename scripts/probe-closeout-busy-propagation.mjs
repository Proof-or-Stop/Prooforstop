import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
import {mkdtempSync,rmSync} from 'node:fs';import {join,resolve} from 'node:path';import {tmpdir} from 'node:os';
const ordinary=process.argv.includes('--ordinary');
const injectedMessage=ordinary ? 'INJECTED_ORDINARY_PERSISTENCE' : '[VALIDATION_METADATA_BUSY] INJECTED_EXACT_POST_WRITE_REFUSAL';
let injected=0;
registerHooks({load(url,ctx,next){const result=next(url,ctx);if(url.endsWith('/core/auto-commit-metadata.js')){
 const source=String(result.source),needle='export function autoCommitStoryMetadata(projectRoot, storyId, reason, options = {}) {';
 assert.ok(source.includes(needle),'test-only fault seam must match the real exported function');
 return {...result,source:source.replace(needle,needle+"\nthrow new Error("+JSON.stringify(injectedMessage)+");")};
}return result;}});
const {StoryStore}=await import(resolve('packages/main/dist/core/store.js'));
const {createProofStoryHandlers}=await import(resolve('packages/main/dist/handlers/proofstory.js'));
const {createCertificationWindowHandlers}=await import(resolve('packages/main/dist/handlers/certification-window.js'));
const {persistBlockedCertificationWindow}=await import(resolve('packages/main/dist/core/certification-window.js'));
const root=mkdtempSync(join(tmpdir(),'pos-busy-v3-')),storyId='B-busy',now=new Date().toISOString(),failures=[];
try{
 const store=new StoryStore(root);store.writeStory(storyId,{storyId,name:'busy-proof',title:'Busy proof',description:'Disposable fault-injection fixture',type:'feature',phase:'DEV',priority:'high',createdAt:now,startedAt:null,endedAt:null});store.writeChecklist(storyId,{items:[{id:'CHK-1',title:'first',status:'done',startTime:null,endTime:null},{id:'CHK-2',title:'second',status:'done',startTime:null,endTime:null}]});
 const ctx={root,scanRoot:root,store};
 for(const [name,run] of [
  ['scope',()=>createProofStoryHandlers(ctx).scope_shrinkage_decision_set({storyId,decision:'confirmed',userConfirmed:true,reason:'Authorized fixture withdrawal',approvedBy:'fixture',withdrawnChecklistItemRefs:['CHK-2']})],
  ['certification',()=>{persistBlockedCertificationWindow({store,storyId,blockerCode:'fixture-blocked',blockerDetail:'fixture'});return createCertificationWindowHandlers(ctx).certification_window_cancel({storyId,reason:'fixture cancel'});}],
 ]){
  let output=null,error=null;try{output=run();}catch(e){error=String(e.message);}
  console.log(JSON.stringify({name,output,error}));
  if(ordinary){assert.equal(error,null);if(name==='scope'){assert.equal(store.readChecklist(storyId).items[1].status,'withdrawn');}else assert.match(JSON.stringify(store.readCertificationWindows(storyId)),/CANCELLED/);injected++;continue;}
  if(name==='scope'){assert.equal(store.readScopeShrinkageDecision(storyId),null);assert.equal(store.readChecklist(storyId).items[1].status,'done');}
  if(name==='certification'){assert.match(error ?? '',/already recorded.*certification_window_status.*original/);assert.match(JSON.stringify(store.readCertificationWindows(storyId)),/CANCELLED/);}
  if(!error?.includes('INJECTED_EXACT_POST_WRITE_REFUSAL'))failures.push(name);else injected++;
 }
 assert.deepEqual(failures,[],'BUSY_REFUSAL_MUST_NOT_BE_SWALLOWED');assert.equal(injected,2);
 console.log(ordinary ? 'ORDINARY_PERSISTENCE_COMPATIBILITY_GREEN' : 'BUSY_PROPAGATION_V3_GREEN: both actual handler catches propagate; module-level deterministic fault injection');
}finally{rmSync(root,{recursive:true,force:true});}
