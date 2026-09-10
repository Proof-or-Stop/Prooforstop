import {mkdtempSync,mkdirSync,realpathSync,rmSync,existsSync,writeFileSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';import {join} from 'node:path';import {execFileSync,spawnSync} from 'node:child_process';
import {fileURLToPath,pathToFileURL} from 'node:url';
const repo=realpathSync(process.argv[2]??fileURLToPath(new URL('..',import.meta.url))),base=realpathSync(mkdtempSync(join(tmpdir(),'u08-full-lane-'))),source=join(base,'source'),main=join(base,'main');
const {buildManagedReviewLane}=await import(pathToFileURL(join(repo,'packages/main/dist/core/managed-review-lane-build.mjs')).href);
try {
 execFileSync('git',['clone','--shared','--no-checkout',repo,main],{stdio:'pipe'});
 const headHash=execFileSync('git',['rev-parse','HEAD'],{cwd:repo,encoding:'utf8'}).trim();
 execFileSync('git',['checkout','-B','main',headHash],{cwd:main,stdio:'pipe'});
 execFileSync('git',['worktree','add','--detach',source,headHash],{cwd:main,stdio:'pipe'});
 const lane=join(base,'lane');mkdirSync(lane);
 const roots=Object.fromEntries(['buildSource','outputs','temporary','cache'].map(n=>{const p=n==='outputs'?join(source,'.proof-or-stop/runtime/managed-review-build'):join(lane,n);mkdirSync(p,{recursive:true});return [n,p]}));
 const result=buildManagedReviewLane({source,...roots,headHash,toolRoot:repo});
 const npmEntry=(process.env.PATH??'').split(':').map(dir=>join(dir,'npm')).find(existsSync);if(!npmEntry)throw Error('npm unavailable for isolated typecheck witness');
 const fixtureBin=join(roots.temporary,'fixture-bin');mkdirSync(fixtureBin);const marker=join(roots.temporary,'ambient-tsc-started');
 writeFileSync(join(fixtureBin,'tsc'),`#!/bin/sh\nprintf unexpected > '${marker}'\nexit 97\n`,{mode:0o755});symlinkSync(process.execPath,join(fixtureBin,'node'));
 const policy=['(version 1)','(allow default)','(deny file-write*)','(allow file-write* (literal "/dev/null"))',...[roots.outputs,roots.temporary,roots.cache].map(path=>`(allow file-write* (subpath ${JSON.stringify(path)}))`),...result.deniedSharedDist.map(path=>`(deny file-read* (subpath ${JSON.stringify(path)}))`)].join('\n');
 const checked=spawnSync('/usr/bin/sandbox-exec',['-p',policy,process.execPath,realpathSync(npmEntry),'--prefix',join(source,'packages/graph'),'run','typecheck'],{cwd:source,env:{...process.env,PATH:fixtureBin+':/usr/bin:/bin',TMPDIR:roots.temporary,npm_config_cache:roots.cache},encoding:'utf8',timeout:60000,maxBuffer:8*1024*1024});
 if(checked.status!==0||checked.error||existsSync(marker)||!checked.stdout.includes('GRAPH_TSC_CLEAN'))throw Error('private npm graph typecheck failed '+checked.stdout+checked.stderr+String(checked.error??''));
 console.log('PASS graph npm typecheck uses private package tsc; fake ambient tsc never launched');
 console.log('PASS isolated actual repository tsc',JSON.stringify(result));
} finally {rmSync(base,{recursive:true,force:true});}
