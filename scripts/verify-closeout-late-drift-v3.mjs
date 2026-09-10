import assert from 'node:assert/strict';import {execFileSync} from 'node:child_process';import {mkdtempSync,writeFileSync,readFileSync,rmSync,symlinkSync,chmodSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';import {createHash} from 'node:crypto';
import {commitImmutableMetadataTree} from '../packages/main/dist/core/done-prepare-generated-metadata.js';
const hash=s=>createHash('sha256').update(s).digest('hex'),failed=[];
for(const mode of ['clean','after-tree','before-cas','deleted','symlink','symlink-same','foreign-index','foreign-head','post-hook','post-hook-index']){
 const root=mkdtempSync(join(tmpdir(),'pos-late-v3-'));const git=args=>execFileSync('git',args,{cwd:root,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
 try{
  git(['init','-q','-b','main']);git(['config','user.name','Lab Proof']);git(['config','user.email','lab@example.invalid']);writeFileSync(join(root,'metadata.json'),'baseline');git(['add','.']);git(['commit','-qm','baseline']);const before=git(['rev-parse','HEAD']);let foreignHead=null;
  writeFileSync(join(root,'metadata.json'),'owned');const mutate=()=>{
   if(mode==='foreign-head'){foreignHead=git(['commit-tree',git(['rev-parse','HEAD^{tree}']),'-p',before,'-m','foreign actor']);git(['update-ref','refs/heads/main',foreignHead,before]);}
   else if(mode==='deleted')rmSync(join(root,'metadata.json'));
   else if(mode==='symlink'||mode==='symlink-same'){writeFileSync(join(root,'outside.txt'),mode==='symlink-same'?'owned':'FOREIGN');rmSync(join(root,'metadata.json'));symlinkSync('outside.txt',join(root,'metadata.json'));}
   else {writeFileSync(join(root,'metadata.json'),'FOREIGN');if(mode==='foreign-index')git(['add','metadata.json']);}
  };
  if(mode.startsWith('post-hook')){const hook=join(root,'.git/hooks/post-commit');writeFileSync(hook,"#!/bin/sh\nprintf FOREIGN > metadata.json\n"+(mode==='post-hook-index'?"unset GIT_INDEX_FILE\ngit add -- metadata.json\n":""));chmodSync(hook,0o755);}
  const hooks=mode==='after-tree'?{afterTreeVerificationBeforeCommit:mutate}:mode==='clean'||mode.startsWith('post-hook')?{}:{beforeCasUpdate:mutate};
  const result=commitImmutableMetadataTree({root,gitCwd:root,paths:['metadata.json'],verifiedHashes:new Map([['metadata.json',hash('owned')]]),message:'owned publication',testHooks:hooks});
  console.log(JSON.stringify({mode,result,head:git(['rev-parse','HEAD']),before,foreignHead}));
  if(mode==='clean'){assert.equal(result.ok,true);assert.equal(git(['show','HEAD:metadata.json']),'owned');}
  else {assert.equal(result.ok,false,'LATE_DRIFT_MUST_REFUSE '+mode);assert.equal(git(['rev-parse','HEAD']),foreignHead??before);if(mode==='foreign-index'||mode==='post-hook-index')assert.equal(git(['show',':metadata.json']),'FOREIGN','foreign stage must survive');if(mode==='symlink'||mode==='symlink-same')assert.equal(readFileSync(join(root,'outside.txt'),'utf8'),mode==='symlink-same'?'owned':'FOREIGN');}
 }catch(error){failed.push(mode);console.error(String(error));}finally{rmSync(root,{recursive:true,force:true});}
}
assert.deepEqual(failed,[],'LATE_DRIFT_MATRIX_REGRESSION');console.log('LATE_DRIFT_V3_GREEN: ten real Git scenarios, including same-bytes symlink refusal');
