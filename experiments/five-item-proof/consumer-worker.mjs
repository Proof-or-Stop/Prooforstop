import {execFileSync} from 'node:child_process';
import {readFileSync,writeFileSync,appendFileSync} from 'node:fs';
import {join,resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
const impl=resolve(dirname(fileURLToPath(import.meta.url)),'../../packages/main/dist');
const {StoryStore}=await import(impl+'/core/store.js');
const {createVerifierHandlers}=await import(impl+'/handlers/verifier.js');
const {createDoneRequiredValidationHandlers}=await import(impl+'/handlers/done-required-validation.js');
const {acquireOwnerLease}=await import(impl+'/core/story-owner-lease.js');
const {resetConfigCache}=await import(impl+'/core/config.js');
const [kind,root,out]=process.argv.slice(2),storyId='B-labconsumer';resetConfigCache();
const store=new StoryStore(root),ctx={store,root,scanRoot:join(root,'src'),log:x=>process.stderr.write(x+'\n')};
acquireOwnerLease(store.storyDirPath(storyId),{command:'isolated-consumer-fixture',cwd:root});
// The isolated admission fixture was created and committed before either consumer.
writeFileSync(out+'.preflight.json',JSON.stringify({status:execFileSync('git',['status','--porcelain=v1','-uall'],{cwd:root,encoding:'utf8'})},null,2));
const negative=kind==='done'?process.env.FIVE_ITEM_NEGATIVE:'';
let beforeHead;
if(negative){
 beforeHead=execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'});
 if(negative==='dirty-source'){appendFileSync(join(root,'src/add.mjs'),'// uncommitted source control\n');execFileSync('git',['add','src/add.mjs'],{cwd:root});}
 else if(negative==='dirty-metadata')appendFileSync(join(root,'.proof-or-stop/story/actives',storyId,'certification-window.json'),'\n');
 else throw new Error('unknown negative fixture');
}
let result=kind==='routine'?await createVerifierHandlers(ctx).validate({story:storyId,json:true,noSync:true}):await createDoneRequiredValidationHandlers(ctx).done_required_validate({storyId,json:true});
if(negative && execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'})!==beforeHead)throw new Error('refusal must not commit any fixture bytes');
writeFileSync(out,typeof result==='string'?result:JSON.stringify(result,null,2));console.log(result);
