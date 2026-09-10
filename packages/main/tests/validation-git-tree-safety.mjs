import assert from 'node:assert/strict';import fs from 'node:fs';import cp from 'node:child_process';import {syncBuiltinESMExports} from 'node:module';import {join,resolve} from 'node:path';import {tmpdir} from 'node:os';
const repo=process.cwd(),runtime=process.env.LAB_RUNTIME_ROOT||repo;
const {captureEvidenceHashSnapshot:capture,currentMaterialHash:material,currentStoryFilesHash:story}=await import(resolve(runtime,'packages/main/dist/core/evidence-freshness.js'));
const {resolveStoryChangedFiles:changed}=await import(resolve(runtime,'packages/main/dist/core/story-aware-validation.js'));
const original=cp.execFileSync,root=fs.mkdtempSync(join(tmpdir(),'pos-tree-safety-'));const checks=[];
const git=(cwd,args)=>original('git',args,{cwd,encoding:'utf8',stdio:'pipe'}).trim();
try{
 for(const format of ['sha1','sha256']){
  const cwd=join(root,format);fs.mkdirSync(cwd);git(cwd,['init','-q','-b','main','--object-format='+format]);git(cwd,['config','user.name','Lab']);git(cwd,['config','user.email','lab@example.invalid']);
  fs.mkdirSync(join(cwd,'src'));fs.writeFileSync(join(cwd,'src/original'),'A');git(cwd,['add','.']);git(cwd,['commit','-qm','base']);git(cwd,['checkout','-qb','story']);
  for(const name of ['space name','tab\tname','中文','new\nline'])fs.writeFileSync(join(cwd,'src',name),name);git(cwd,['add','.']);git(cwd,['commit','-qm','names']);
  for(const dir of [cwd,join(cwd,'src')]){
   const s=capture({gitCwd:dir,metadataRoot:cwd});assert.equal(s.materialHash,material(dir,'HEAD',cwd));assert.equal(s.storyFilesHash,story(dir,'HEAD',cwd));assert(s.materialHash);if(dir===cwd)assert(s.storyFilesHash);else console.log("SUBDIR_EXISTING_BEHAVIOR "+JSON.stringify({storyFilesHash:s.storyFilesHash??null}));
  }
  git(cwd,['tag','-a','snapshot-tag','-m','annotated']);const tagged=capture({gitCwd:cwd,ref:'snapshot-tag'});assert.equal(tagged.materialHash,material(cwd,'snapshot-tag'));assert.equal(tagged.storyFilesHash,story(cwd,'snapshot-tag'));assert.equal(tagged.materialHash,material(cwd,git(cwd,['rev-parse','snapshot-tag^{commit}'])));
  // A wrapper supplies its own metadata-root config, as in production routing.
  const wrapper=join(root,'wrapper-'+format);fs.mkdirSync(wrapper);fs.writeFileSync(join(wrapper,'proof-or-stop.config.json'),JSON.stringify({storyDir:'custom-stories/'}));
  fs.mkdirSync(join(cwd,'custom-stories'));fs.writeFileSync(join(cwd,'custom-stories/meta'),'metadata');git(cwd,['add','.']);git(cwd,['commit','-qm','metadata']);
  const excluded=capture({gitCwd:cwd,metadataRoot:wrapper});assert.equal(excluded.materialHash,material(cwd,'HEAD',wrapper));assert.notEqual(excluded.materialHash,material(cwd,'HEAD',cwd));
  const before=capture({gitCwd:cwd});let reads=0;
  cp.execFileSync=function(cmd,args,opts){if(cmd==='git'&&args[0]==='ls-tree')reads++;return original.call(this,cmd,args,opts)};syncBuiltinESMExports();
  let after;try{fs.writeFileSync(join(cwd,'src/original'),'B');git(cwd,['add','.']);git(cwd,['commit','-qm','changed']);after=capture({gitCwd:cwd});}finally{cp.execFileSync=original;syncBuiltinESMExports();}
  assert(reads>=1);assert.notEqual(after.materialHash,before.materialHash);
  cp.execFileSync=function(cmd,args,opts){if(cmd==='git'&&args[0]==='ls-tree')throw Object.assign(new Error('injected'),{code:'ENOBUFS'});return original.call(this,cmd,args,opts)};syncBuiltinESMExports();
  try{assert.equal(material(cwd),undefined);assert.throws(()=>changed(cwd),/could not read tree/);}finally{cp.execFileSync=original;syncBuiltinESMExports();}
  assert(capture({gitCwd:cwd}).materialHash);checks.push({format,cases:['unicode-space-tab-newline','subdir','annotated-tag','wrapper-root','next-batch-reads','ENOBUFS-error-contract','retry-after-failure']});
 }
 assert.notEqual(capture({gitCwd:join(root,'sha1')}).materialHash,capture({gitCwd:join(root,'sha256')}).materialHash);
 console.log('GIT_TREE_SAFETY_GREEN '+JSON.stringify(checks));
}finally{cp.execFileSync=original;syncBuiltinESMExports();fs.rmSync(root,{recursive:true,force:true});}
