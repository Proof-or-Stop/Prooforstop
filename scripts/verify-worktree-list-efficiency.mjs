import assert from 'node:assert/strict';import cp from 'node:child_process';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import{pathToFileURL}from'node:url';import{syncBuiltinESMExports}from'node:module';
const repo=fs.realpathSync(process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : process.cwd()),original=cp.execFileSync;let observed=false,calls=[];
cp.execFileSync=function(command,args,...rest){if(observed&&command==='git')calls.push([...args]);return original.call(this,command,args,...rest);};syncBuiltinESMExports();
const {listGitWorktrees}=await import(pathToFileURL(path.join(repo,'packages/main/dist/core/worktree-runtime.js')));
const base=fs.mkdtempSync(path.join(os.tmpdir(),'u17-worktree-list-')),main=path.join(base,'main'),linked=path.join(base,'linked'),outside=path.join(base,'outside');fs.mkdirSync(main);fs.mkdirSync(outside);const prior=process.cwd();const rows=[];
function git(...args){return original('git',args,{cwd:main,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();}
function query(label,cwd){calls=[];observed=true;let result;try{result=listGitWorktrees(cwd);}finally{observed=false;}rows.push({label,calls:[...calls]});return result;}
try{
git('init','-b','main');git('config','user.email','fixture@example.test');git('config','user.name','fixture');git('config','commit.gpgsign','false');fs.writeFileSync(path.join(main,'file'),'fixture');git('add','.');git('commit','-qm','fixture');git('worktree','add','-b','linked',linked);fs.mkdirSync(path.join(main,'sub'));fs.mkdirSync(path.join(linked,'sub'));
const expected=query('main',main);assert.equal(expected.length,2);for(const [label,cwd]of (process.argv.includes('--performance-only')?[['linked',linked]]:[['linked',linked],['main child',path.join(main,'sub')],['linked child',path.join(linked,'sub')]]))assert.deepEqual(query(label,cwd),expected,label);
process.chdir(base);assert.deepEqual(query('relative main','main'),expected);if(!process.argv.includes('--performance-only'))assert.deepEqual(query('relative linked child','linked/sub'),expected);assert.deepEqual(query('outside',outside),[]);assert.deepEqual(query('missing',path.join(base,'missing')),[]);
const another=path.join(base,'another');git('worktree','add','-b','another',another);assert.equal(query('after add',linked).length,3);git('worktree','remove',another);assert.deepEqual(query('after remove',linked),expected);
// Worktree HEAD/branch values stay live, not cached merely by directory identity.
git('-C',linked,'checkout','--detach');assert.equal(query('detached',main).find(r=>r.path===fs.realpathSync(linked)).branch,null);git('-C',linked,'checkout','linked');assert.deepEqual(query('reattached',main),expected);
console.log('WORKTREE_SEMANTICS_PASS queries='+rows.length);
for(const row of rows)assert.deepEqual(row.calls,[['worktree','list','--porcelain']],'WORKTREE_LIST_REDUNDANT_ROOT_PROBES: '+row.label);console.log('U17_WORKTREE_LIST_ONE_GIT_CALL_PASS');
}finally{process.chdir(prior);cp.execFileSync=original;syncBuiltinESMExports();fs.rmSync(base,{recursive:true,force:true});}
if(process.argv.includes('--performance-only')) original(process.execPath,[process.argv[1],repo],{cwd:repo,stdio:'inherit',timeout:60000});
