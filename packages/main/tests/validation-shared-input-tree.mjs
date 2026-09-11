#!/usr/bin/env node
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,readFileSync,rmSync,mkdirSync,existsSync,statSync,utimesSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
const repo=process.cwd();

const {runValidationCommand}=await import(resolve(repo,'packages/main/dist/core/validation-executor.js'));
const shared=await import(resolve(repo,'packages/main/dist/core/shared-validation-execution.js'));
const {StoryStore}=await import(resolve(repo,'packages/main/dist/core/store.js'));
const {acquireOwnerLease}=await import(resolve(repo,'packages/main/dist/core/story-owner-lease.js'));
const {probeValidationCausalPreflightFacts}=await import(resolve(repo,'packages/main/dist/handlers/verifier.js'));
const root=mkdtempSync(join(tmpdir(),'pos-reuse-proof-'));
const originalCwd=process.cwd();
const git=argv=>execFileSync('git',argv,{cwd:root,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
const evidence=[];
const check=(name,actual)=>{evidence.push({name,...actual});console.log('PROOF '+JSON.stringify({name,...actual}));};
try{
 git(['init','-q','-b','main']);git(['config','user.name','Reuse proof']);git(['config','user.email','proof@example.invalid']);
 writeFileSync(join(root,'.gitignore'),'.proof-or-stop/\n');
 mkdirSync(join(root,'packages/main'),{recursive:true});writeFileSync(join(root,'packages/main/package.json'),readFileSync(join(repo,'packages/main/package.json')));
 writeFileSync(join(root,'package.json'),JSON.stringify({name:'proof-fixture',version:'1.0.0'}));
 writeFileSync(join(root,'proof-or-stop.config.json'),JSON.stringify({scanRoot:'.',rootDir:'src',storyDir:'.proof-or-stop/story/actives'}));
 writeFileSync(join(root,'witness.mjs'),"import {randomUUID} from 'node:crypto';await new Promise(r=>setTimeout(r,150));console.log('WITNESS '+randomUUID());\n");
 git(['add','.']);git(['commit','-qm','fixed witness inputs']);git(['status','--porcelain']);
 process.chdir(root);
 const store=new StoryStore(root),storyId='B-reuse-proof';
 acquireOwnerLease(store.storyDirPath(storyId),{command:'validate',cwd:root});
 const ctx={root,store,scanRoot:root};
 const context={storyId,receiptStore:store,probe:input=>probeValidationCausalPreflightFacts(ctx,storyId,input)};
 const spec={label:'validate',command:process.execPath,args:['witness.mjs'],executionReuse:'exact-inputs',executionInputs:[]};
 const run=(extra={},options={})=>runValidationCommand({...spec,...extra},root,10000,{sharedExecution:context,...options});

 const generated=join(root,'.proof-or-stop','generated');mkdirSync(generated,{recursive:true});
 writeFileSync(join(generated,'entry.mjs'),"import {value} from './dep.mjs';console.log(value);\n");writeFileSync(join(generated,'dep.mjs'),"export const value='ORIGINAL';\n");
 const extra={args:[join(generated,'entry.mjs')],executionInputs:[generated]};
 const first=await run(extra),second=await run(extra);
 assert.equal(first.code,0);assert.equal(second.code,0);assert.equal(second.output.trim(),'ORIGINAL');
 assert.equal(second.executionReceipt?.disposition,'reused','GENERATED_INPUT_TREE_MUST_SUPPORT_SAFE_REUSE');
 writeFileSync(join(generated,'dep.mjs'),"export const value='CHANGED';\n");
 const changed=await run(extra);assert.equal(changed.output.trim(),'CHANGED');assert.equal(changed.executionReceipt.disposition,'executed','Ignored transitive module changes must invalidate');
 writeFileSync(join(generated,'new-module.mjs'),"export const added=true;\n");
 const added=await run(extra);assert.equal(added.executionReceipt.disposition,'executed','New modules must bind without a manually refreshed manifest');
 writeFileSync(join(generated,'slow.mjs'),"await new Promise(r=>setTimeout(r,500));console.log('WAITED');\n");
 const dep=join(generated,'dep.mjs'),beforeStat=statSync(dep);
 let mutatedInFlight=false;
 const timer=setTimeout(()=>{if(process.argv.includes('--delete'))rmSync(dep);else if(process.argv.includes('--fifo')){rmSync(dep);execFileSync('mkfifo',[dep]);}else{writeFileSync(dep,"export const value='TAMPER!';\n");utimesSync(dep,beforeStat.atime,beforeStat.mtime);}mutatedInFlight=true;},150);
 try {await assert.rejects(run({...extra,args:[join(generated,'slow.mjs')]}),/inputs changed|preflight|publication/,'mtime restoration must not hide in-flight drift');}finally{clearTimeout(timer);}
 assert.equal(mutatedInFlight,true,'Negative witness must actually change dependency bytes and restore mtime');
 if(!existsSync(dep)||process.argv.includes('--fifo')){if(existsSync(dep))rmSync(dep);writeFileSync(dep,"export const value='RESTORED';\n");}
 const selfWriter=join(generated,'self-writer.mjs');
 writeFileSync(selfWriter,"import {writeFileSync} from 'node:fs';writeFileSync(new URL('./own-output.txt',import.meta.url),'changed');console.log('CHILD_SUCCEEDED');\n");
 await assert.rejects(run({...extra,args:[selfWriter]}),/inputs changed|publication/,'A successful command cannot publish after writing its declared input tree');
 assert.equal(readFileSync(join(generated,'own-output.txt'),'utf8'),'changed');
 console.log('SELF_WRITTEN_INPUT_REFUSED_AFTER_CHILD_SUCCESS');
 const cycle=join(generated,'cycle');symlinkSync(generated,cycle,'dir');
 const unsafe=await run(extra);assert.equal(unsafe.executionDecision.reason,'input_unreadable','Input cycles refuse reuse instead of hanging');rmSync(cycle);
 console.log('GENERATED_INPUT_REPORT '+JSON.stringify({unchanged:{firstKey:first.executionReceipt.executionKey,secondKey:second.executionReceipt.executionKey,decision:second.executionDecision},modifiedDependency:{key:changed.executionReceipt.executionKey,output:changed.output,decision:changed.executionDecision},addedModule:{key:added.executionReceipt.executionKey,decision:added.executionDecision},restoredMtimeMutation:{injected:mutatedInFlight,rejected:true},cycle:unsafe.executionDecision}));
 console.log('GENERATED_INPUT_TREE_V4_GREEN');
}finally{process.chdir(originalCwd);rmSync(root,{recursive:true,force:true});}
