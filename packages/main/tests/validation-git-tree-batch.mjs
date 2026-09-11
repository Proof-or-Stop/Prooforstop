// Exercise physical reads explicitly; persistent main memo legitimately skips warm reads.
process.env.GIT_REPLACE_REF_BASE = 'refs/lab-v17-no-replacements/';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import cp from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {resolve,join} from 'node:path';
import {tmpdir} from 'node:os';
const repo=process.cwd(),runtime=process.env.LAB_RUNTIME_ROOT||repo;
const {probeValidationCausalPreflightFacts:probe}=await import(resolve(runtime,'packages/main/dist/handlers/verifier.js'));
const {captureEvidenceHashSnapshot:capture,currentMaterialHash,currentStoryFilesHash,checkEvidenceFreshnessForGit:relaxed,checkStrictVerificationEvidenceFreshnessForGit:strict}=await import(resolve(runtime,'packages/main/dist/core/evidence-freshness.js'));
const {StoryStore}=await import(resolve(runtime,'packages/main/dist/core/store.js'));
const shellOriginal=cp.execSync;
const root=fs.mkdtempSync(join(tmpdir(),'pos-git-tree-batch-')),original=cp.execFileSync;
const git=args=>original('git',args,{cwd:root,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
try{
 git(['init','-q','-b','main']);git(['config','user.name','Lab fixture']);git(['config','user.email','lab@example.invalid']);
 fs.writeFileSync(join(root,'.gitignore'),'.proof-or-stop/\n');fs.writeFileSync(join(root,'proof-or-stop.config.json'),JSON.stringify({scanRoot:'.',storyDir:'.proof-or-stop/story/actives'}));
 fs.mkdirSync(join(root,'src'));for(let i=0;i<500;i++)fs.writeFileSync(join(root,'src',i+'.txt'),String(i));
 git(['add','.']);git(['commit','-qm','baseline']);git(['checkout','-qb','fixture']);fs.writeFileSync(join(root,'src/changed.txt'),'changed');git(['add','.']);git(['commit','-qm','subject']);
 const ctx={root,store:new StoryStore(root),scanRoot:root};
 const expected={materialHash:currentMaterialHash(root),storyFilesHash:currentStoryFilesHash(root)};
 const observed=[];
 for(const kind of ['probe','capture','strict','relaxed']){
  const rows=[];cp.execFileSync=function(command,args,options){const start=performance.now();try{return original.call(this,command,args,options);}finally{if(command==='git')rows.push({args,ms:performance.now()-start});}};syncBuiltinESMExports();
  cp.execSync=function(command,options){const start=performance.now();try{return shellOriginal.call(this,command,options);}finally{rows.push({shell:command,ms:performance.now()-start});}};syncBuiltinESMExports();
  const start=performance.now();let facts;
  try{facts=kind==='probe'?probe(ctx,'B-tree-batch',{command:'node --version',cwd:root,timeoutMs:10000}).gitMaterial:kind==='capture'?capture({gitCwd:root}):kind==='strict'?strict(root,git(['rev-parse','HEAD']),expected.materialHash,root,expected.storyFilesHash):relaxed(root,git(['rev-parse','HEAD']),'0'.repeat(64),root,expected.storyFilesHash);if(kind==='strict'||kind==='relaxed'){assert(facts.fresh);facts={materialHash:facts.currentMaterialHash,storyFilesHash:facts.currentStoryFilesHash};}}finally{cp.execFileSync=original;cp.execSync=shellOriginal;syncBuiltinESMExports();}
  assert.equal(facts.materialHash,expected.materialHash);assert.equal(facts.storyFilesHash,expected.storyFilesHash);
  const trees=rows.filter(r=>r.args?.[0]==='ls-tree');
  console.log('GIT_TREE_BATCH_LEDGER='+JSON.stringify({kind,seconds:(performance.now()-start)/1000,gitCalls:rows.length,gitMs:rows.reduce((n,r)=>n+r.ms,0),treeReads:trees.length,rows}));
  observed.push(trees.length);
 }
 // No cross-snapshot caching, including committed edits and deletions.
 for(const action of ['edit','rename','delete']){
  const before=capture({gitCwd:root});
  if(action==='edit')fs.writeFileSync(join(root,'src/changed.txt'),'new-content');
  if(action==='rename')fs.renameSync(join(root,'src/changed.txt'),join(root,'src/renamed\tfile.txt'));
  if(action==='delete')fs.rmSync(join(root,'src/renamed\tfile.txt'));
  git(['add','-A']);git(['commit','-qm',action]);
  const next=capture({gitCwd:root});assert.notEqual(next.materialHash,before.materialHash);
  assert.equal(next.materialHash,currentMaterialHash(root));assert.equal(next.storyFilesHash,currentStoryFilesHash(root));
 }
 const fail=()=>{throw new Error('INJECTED_TREE_FAILURE');};
 cp.execFileSync=function(cmd,argv,options){if(cmd==='git'&&argv[0]==='ls-tree')return fail();return original.call(this,cmd,argv,options);};syncBuiltinESMExports();
 try{const failed=capture({gitCwd:root});assert.equal(failed.materialHash,undefined);assert.equal(failed.storyFilesHash,undefined);}finally{cp.execFileSync=original;cp.execSync=shellOriginal;syncBuiltinESMExports();}
 assert(capture({gitCwd:root}).materialHash,'Failed reads cannot poison subsequent snapshots');
 const invalid=capture({gitCwd:root,ref:'refs/heads/does-not-exist'});assert.equal(invalid.headHash,undefined);assert.equal(invalid.materialHash,undefined);assert.equal(invalid.storyFilesHash,undefined);
 console.log('GIT_TREE_BATCH_SAFETY_GREEN edit rename-tab delete read-failure fresh-after-failure');
 assert.deepEqual(observed,[1,1,1,1],'ONE_PROTECTED_SNAPSHOT_MUST_READ_ITS_IMMUTABLE_GIT_TREE_ONCE');
 console.log('GIT_TREE_BATCH_GREEN');
}finally{cp.execFileSync=original;syncBuiltinESMExports();fs.rmSync(root,{recursive:true,force:true});}
