import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync,realpathSync} from 'node:fs';import {tmpdir} from 'node:os';import {join,resolve} from 'node:path';import {execFileSync} from 'node:child_process';
const {resolveSharedLockRoot}=await import(resolve('packages/main/dist/core/validation-execution-lock.js'));
const keys=['GIT_DIR','GIT_COMMON_DIR','GIT_WORK_TREE'];const saved=keys.map(k=>[k,process.env[k]]);const root=mkdtempSync(join(tmpdir(),'pos-routing-lock-'));const git=(cwd,args)=>execFileSync('git',args,{cwd,stdio:'pipe'});
try{
 for(const k of keys)delete process.env[k];
 for(const name of ['a','b']){git(root,['init','-q',name]);const dir=join(root,name);git(dir,['config','user.name','Lab']);git(dir,['config','user.email','lab@example.invalid']);writeFileSync(join(dir,'source'),'fixed');git(dir,['add','.']);git(dir,['commit','-qm','Temporary routing fixture']);}
 const a=join(root,'a'),b=join(root,'b'),w=join(root,'linked');git(a,['worktree','add','-q','-b','temporary-linked',w]);
 assert.equal(resolveSharedLockRoot(w),realpathSync(a));assert.equal(resolveSharedLockRoot(w),realpathSync(a));
 for(const key of ['GIT_DIR','GIT_COMMON_DIR']){
  process.env[key]=join(b,'.git');assert.equal(resolveSharedLockRoot(w),realpathSync(b),'Ambient routing must bypass the warmed worktree cache');delete process.env[key];assert.equal(resolveSharedLockRoot(w),realpathSync(a));
 }
 process.env.GIT_WORK_TREE=b;assert.equal(resolveSharedLockRoot(w),realpathSync(a));delete process.env.GIT_WORK_TREE;
 console.log('LINKED_WORKTREE_COMMON_ROOT_AND_ROUTING_CACHE_BYPASS_GREEN');
}finally{for(const [k,value] of saved){if(value===undefined)delete process.env[k];else process.env[k]=value;}rmSync(root,{recursive:true,force:true});}
