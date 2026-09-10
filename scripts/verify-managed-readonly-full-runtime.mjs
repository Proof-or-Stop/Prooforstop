import {mkdtempSync,mkdirSync,realpathSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';import {join} from 'node:path';import {execFileSync} from 'node:child_process';
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
 console.log('PASS isolated actual repository tsc',JSON.stringify(result));
} finally {rmSync(base,{recursive:true,force:true});}
