// Exercise physical reads explicitly; persistent main memo legitimately skips warm reads.
process.env.GIT_REPLACE_REF_BASE = 'refs/lab-v17-no-replacements/';
import assert from 'node:assert/strict';import fs from 'node:fs';import cp from 'node:child_process';import {syncBuiltinESMExports} from 'node:module';import {resolve,join} from 'node:path';import {tmpdir} from 'node:os';
const runtime=process.env.LAB_RUNTIME_ROOT||process.cwd();
const {captureEvidenceHashSnapshot:capture,currentStoryFilesHash:story}=await import(resolve(runtime,'packages/main/dist/core/evidence-freshness.js'));
const root=fs.mkdtempSync(join(tmpdir(),'pos-tree-head-drift-')),original=cp.execFileSync;
const git=args=>original('git',args,{cwd:root,encoding:'utf8',stdio:'pipe'}).trim();
try{
 git(['init','-q','-b','main']);git(['config','user.name','Lab']);git(['config','user.email','lab@example.invalid']);fs.writeFileSync(join(root,'subject'),'base');git(['add','.']);git(['commit','-qm','base']);git(['checkout','-qb','story']);fs.writeFileSync(join(root,'subject'),'first');git(['add','.']);git(['commit','-qm','first']);
 const before=capture({gitCwd:root});let injected=false;
 cp.execFileSync=function(cmd,args,opts){const value=original.call(this,cmd,args,opts);if(cmd==='git'&&args[0]==='ls-tree'&&!injected){injected=true;fs.writeFileSync(join(root,'subject'),'second');git(['add','.']);git(['commit','-qm','concurrent head advance']);}return value;};syncBuiltinESMExports();
 let snapshot;try{snapshot=capture({gitCwd:root});}finally{cp.execFileSync=original;syncBuiltinESMExports();}
 assert(injected);const after=capture({gitCwd:root});
 console.log('HEAD_DRIFT_LEDGER='+JSON.stringify({before,snapshot,after}));
 assert.equal(snapshot.headHash,before.headHash);assert.equal(snapshot.materialHash,before.materialHash);
 assert.equal(snapshot.storyFilesHash,before.storyFilesHash,'ONE_SNAPSHOT_MUST_NOT_MIX_TWO_HEADS');
 assert.notEqual(after.headHash,snapshot.headHash);assert.notEqual(after.materialHash,snapshot.materialHash);assert.notEqual(after.storyFilesHash,snapshot.storyFilesHash);
 console.log('HEAD_DRIFT_GREEN coherent-old-snapshot next-observation-detects-new-head');
}finally{cp.execFileSync=original;syncBuiltinESMExports();fs.rmSync(root,{recursive:true,force:true});}
