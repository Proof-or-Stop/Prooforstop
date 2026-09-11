import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, symlinkSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
const { StoryStore } = await import(resolve('packages/main/dist/core/store.js'));
const { withScopeShrinkageTransaction } = await import(resolve('packages/main/dist/core/scope-shrinkage-transaction.js'));
for (const scenario of ['before-write', 'foreign', 'head-moved', 'wrapper-head', 'dangling-link', 'success']) {
 const root=mkdtempSync(join(tmpdir(),'pos-scope-boundary-')), id='B-boundary';
 const gitRoot=scenario==='wrapper-head'?join(root,'repo'):root;
 if(gitRoot!==root){mkdirSync(gitRoot);writeFileSync(join(root,'proof-or-stop.config.json'),JSON.stringify({gitRoot:'repo'}));}
 const git=(...args)=>execFileSync('git',args,{cwd:gitRoot,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
 try {
  const store=new StoryStore(root);store.writeStory(id,{storyId:id,name:id,title:'Wrapper fixture',description:'Disposable test',phase:'DEV',type:'chore',priority:'medium',createdAt:new Date().toISOString(),startedAt:null,endedAt:null});store.writeChecklist(id,{items:[]});
  const file=store.storyFilePath(id,'scope-shrinkage-decision.json');
  if(scenario==='head-moved'||scenario==='wrapper-head'){writeFileSync(join(gitRoot,'seed'),'before');git('init','-q','-b','main');git('config','user.name','Lab');git('config','user.email','lab@example.invalid');git('add','.');git('commit','-qm','baseline');}
  const expected={decision:'fixture'}, value=JSON.stringify(expected,null,2)+'\n';
  if(scenario==='dangling-link')symlinkSync(join(root,'missing-target'),file);
  const run=()=>withScopeShrinkageTransaction(root,store,id,tx=>{
   tx.write('scope-shrinkage-decision.json',expected,()=>{
    if(scenario==='before-write')throw Error('INJECT_BEFORE');
    writeFileSync(file,value);
    if(scenario==='foreign')writeFileSync(file,'FOREIGN');
    if(scenario==='head-moved'||scenario==='wrapper-head'){writeFileSync(join(gitRoot,'seed'),'after');git('add','.');git('commit','-qm','landed');throw Error('INJECT_AFTER_COMMIT');}
   });
   return 'SUCCESS';
  });
  if(scenario==='success'){assert.equal(run(),'SUCCESS');assert.equal(readFileSync(file,'utf8'),value);}
  else if(scenario==='before-write'){assert.throws(run,/INJECT_BEFORE/);assert.throws(()=>readFileSync(file),/ENOENT/);}
  else if(scenario==='foreign'){assert.throws(run,/RECOVERY_REQUIRED.*foreign bytes preserved/);assert.equal(readFileSync(file,'utf8'),'FOREIGN');}
  else if(scenario==='head-moved'||scenario==='wrapper-head'){assert.throws(run,/RECOVERY_REQUIRED.*HEAD changed/);assert.equal(readFileSync(file,'utf8'),value);assert.equal(git('log','-1','--format=%s'),'landed');}
  else {assert.throws(run,/NONREGULAR_PATH/);assert.throws(()=>readFileSync(join(root,'missing-target')),/ENOENT/);}
  console.log('SCOPE_TRANSACTION_BOUNDARY_GREEN '+scenario);
 } finally {rmSync(root,{recursive:true,force:true});}
}
