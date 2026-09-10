import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtempSync,mkdirSync,cpSync,existsSync,writeFileSync,readFileSync,rmSync,appendFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {dirname,resolve,join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {tmpdir} from 'node:os';
const lab=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const fixture=mkdtempSync(join(tmpdir(),'pos-receipt-identity-')),runtime=join(fixture,'runtime'),previousCwd=process.cwd();
const hash=x=>createHash('sha256').update(x).digest('hex');
const git=a=>execFileSync('git',a,{cwd:fixture,encoding:'utf8',stdio:'pipe'}).trim();
try {
 for(const name of ['main','utils','lab']){const dest=join(runtime,'packages',name);mkdirSync(dest,{recursive:true});for(const sub of ['dist','package.json'])if(existsSync(join(lab,'packages',name,sub)))cpSync(join(lab,'packages',name,sub),join(dest,sub),{recursive:true,verbatimSymlinks:true});}
 for(const path of ['node_modules','bin','scripts','packages/main/templates'])cpSync(join(lab,path),join(runtime,path),{recursive:true,verbatimSymlinks:true});
 cpSync(join(lab,'package.json'),join(runtime,'package.json'));
 mkdirSync(join(fixture,'packages/main'),{recursive:true});writeFileSync(join(fixture,'packages/main/package.json'),JSON.stringify({name:'fixture',version:'1.0.0'}));
 writeFileSync(join(fixture,'package.json'),JSON.stringify({name:'receipt-identity-fixture',type:'module',version:'1.0.0'}));
 writeFileSync(join(fixture,'.gitignore'),'runtime/\n.proof-or-stop/\nignored.txt\n');
 writeFileSync(join(fixture,'witness.mjs'),"import {randomUUID} from 'node:crypto'; console.log('PASS '+randomUUID());\n");
 writeFileSync(join(fixture,'ignored.txt'),'original');
 git(['init','-q','-b','main']);git(['config','user.name','Lab fixture']);git(['config','user.email','lab@example.test']);git(['add','.']);git(['commit','-qm','fixture']);process.chdir(fixture);
 const {runValidationCommand}=await import(pathToFileURL(join(runtime,'packages/main/dist/core/validation-executor.js')).href);
 const receipts=new Map();const receiptStore={readCausalEvidenceReceipt:(_id,key)=>receipts.get(key)??null,writeCausalEvidenceReceipt:(_id,r)=>receipts.set(r.executionKey,structuredClone(r))};
 const probe=()=>({cli:{available:true,path:process.execPath},worktree:{expected:fixture,actual:fixture},gitIndex:{readable:true,path:join(fixture,'.git/index'),contentDigest:hash(readFileSync(join(fixture,'.git/index')))},gitMaterial:{available:true,headHash:git(['rev-parse','HEAD']),materialHash:git(['rev-parse','HEAD^{tree}']),storyFilesHash:git(['rev-parse','HEAD^{tree}'])},writerLease:{available:true,valid:true},providerCapability:{required:['validation-plan'],available:['validation-plan']},resources:{required:{slots:1},available:{slots:1}},evidenceTarget:{writable:true,path:fixture},sideChannel:{available:true,maxOutputChars:12000,maxProgressEvents:1}});
 const sharedExecution={storyId:'B-isolated-identity',receiptStore,probe};
 const spec={label:'identity test',command:process.execPath,args:['witness.mjs'],executionReuse:'exact-inputs',executionInputs:['ignored.txt']};
 const run=()=>runValidationCommand(spec,fixture,10000,{sharedExecution});
 const first=await run(),same=await run();assert.equal(same.executionReceipt.disposition,'reused');assert.equal(first.output,same.output);
 const helper=join(runtime,'packages/main/dist/core/material-code-policy.js'),original=readFileSync(helper);
 appendFileSync(helper,'\n// same version implementation differs\n');
 const changed=await run();assert.equal(changed.executionReceipt.disposition,'executed','RECEIPT_IMPLEMENTATION_NOT_BOUND');assert.notEqual(changed.output,first.output);
 writeFileSync(helper,original);const restored=await run();assert.equal(restored.output,first.output);assert.equal(restored.executionReceipt.disposition,'reused');
 writeFileSync(join(fixture,'ignored.txt'),'changed ignored input');const inputChanged=await run();assert.equal(inputChanged.executionReceipt.disposition,'executed');assert.notEqual(inputChanged.output,first.output);
 console.log('RECEIPT_IMPLEMENTATION_GREEN '+JSON.stringify({first:first.executionReceipt,same:same.executionReceipt,changed:changed.executionReceipt,restored:restored.executionReceipt,inputChanged:inputChanged.executionReceipt}));
}finally{process.chdir(previousCwd);rmSync(fixture,{recursive:true,force:true});}
