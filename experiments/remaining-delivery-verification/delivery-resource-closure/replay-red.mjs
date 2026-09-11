// Replay the exact two baseline source modules in a private runtime copy.
// This is counterproof, not a new timing baseline or a main/worktree mutation.
import ts from 'typescript';
import {mkdtempSync,cpSync,mkdirSync,writeFileSync,readFileSync,symlinkSync,rmSync} from 'node:fs';
import {spawnSync,execFileSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join,resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
const repo=resolve(dirname(fileURLToPath(import.meta.url)),'../../..'),root=mkdtempSync(join(tmpdir(),'proof-resource-baseline-'));
const baseline='f4bc7b3449';const hashes={};
try{
 mkdirSync(join(root,'packages/main/tests'),{recursive:true});
 cpSync(join(repo,'packages/main/dist'),join(root,'packages/main/dist'),{recursive:true});
 cpSync(join(repo,'package.json'),join(root,'package.json'));cpSync(join(repo,'packages/main/package.json'),join(root,'packages/main/package.json'));
 symlinkSync(join(repo,'node_modules'),join(root,'node_modules'),'dir');symlinkSync(join(repo,'packages/main/node_modules'),join(root,'packages/main/node_modules'),'dir');
 for(const name of ['host-run','host-run-group-anchor']){
  const path='packages/main/src/core/'+name+'.ts';const source=execFileSync('git',['show',baseline+':'+path],{cwd:repo,encoding:'utf8'});hashes[path]=createHash('sha256').update(source).digest('hex');
  const compiled=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText;writeFileSync(join(root,'packages/main/dist/core/'+name+'.js'),compiled);
 }
 const expected=JSON.parse(readFileSync(join(repo,'output/delivery-resource-closure/baseline.json'))).sourceHashes;
 for(const [name,hash] of Object.entries(hashes))assert.equal(hash,expected[name]);
 const name='packages/main/tests/host-run-resource-release.test.mjs';cpSync(join(repo,name),join(root,name));const testSha256=createHash('sha256').update(readFileSync(join(root,name))).digest('hex');
 const result=spawnSync(process.execPath,[join(root,name)],{cwd:root,encoding:'utf8',timeout:90000,maxBuffer:8*1024*1024});
 console.log('REPLAY_SOURCE_BINDING '+JSON.stringify({baseline,sourceHashes:hashes,testSha256,scope:'Only two baseline production modules restored; unchanged dependency modules copied from current Lab; no performance inference'}));
 process.stdout.write(result.stdout??'');process.stderr.write(result.stderr??'');
 assert.equal(result.status,1);assert.match(result.stderr,/BACKGROUND_RESOURCE_RED/);assert.match(result.stderr,/CLEANUP_UNVERIFIED_RED/);console.log('BASELINE_TARGET_RED_CONFIRMED');
}finally{rmSync(root,{recursive:true,force:true});}
