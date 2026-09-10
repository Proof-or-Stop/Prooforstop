import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import {join,dirname} from 'node:path';import {execFileSync} from 'node:child_process';import {pathToFileURL,fileURLToPath} from 'node:url';import {syncBuiltinESMExports} from 'node:module';
const repo=fs.realpathSync(process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : fileURLToPath(new URL('..',import.meta.url))),base=fs.realpathSync(fs.mkdtempSync(join(os.tmpdir(),'u08-real-worker-'))),root=join(base,'project'),bin=join(base,'bin');fs.mkdirSync(root);fs.mkdirSync(bin);const fixtureCodexHome=join(base,'codex-home');fs.mkdirSync(fixtureCodexHome);fs.writeFileSync(join(fixtureCodexHome,'auth.json'),JSON.stringify({auth_mode:'apikey',OPENAI_API_KEY:'fixture-not-a-real-key'}),{mode:0o600});
const originalUserInfo=os.userInfo;os.userInfo=(...args)=>({...originalUserInfo(...args),homedir:base});syncBuiltinESMExports();
const load=p=>import(pathToFileURL(join(repo,'packages/main/dist',p)).href);
const {submitManagedHostRun,runManagedHostRunWorker,managedHostRunDirectory,readManagedHostRunBinding}=await load('core/managed-host-run.js');
const git=args=>execFileSync('git',args,{cwd:root,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
let worker;let workerStarts=0;let snapshotParent;let snapshot;
try {
 for(const p of ['packages/main/src/core','packages/main/src/tasks'])fs.mkdirSync(join(root,p),{recursive:true});
 fs.writeFileSync(join(root,'package.json'),JSON.stringify({name:'proof-or-stop'}));
 fs.writeFileSync(join(root,'packages/main/package.json'),JSON.stringify({name:'@proof-or-stop/core',type:'module'}));
 fs.writeFileSync(join(root,'packages/main/tsconfig.json'),JSON.stringify({compilerOptions:{target:'ES2022',module:'Node16',moduleResolution:'Node16',rootDir:'src',outDir:'dist',skipLibCheck:true},include:['src/**/*.ts']}));
 fs.writeFileSync(join(root,'packages/main/src/cli.ts'),"console.log('0.0.0'); export const actualCompilerInput = 17;\n");
 fs.writeFileSync(join(root,'packages/main/src/index.ts'),'export const coreFixture = 1;\n');
 fs.writeFileSync(join(root,'packages/main/src/extension-api.ts'),'export const extensionFixture = 1;\n');
 for(const name of ['utils','graph','lab']) {fs.mkdirSync(join(root,'packages',name,'src'),{recursive:true});fs.writeFileSync(join(root,'packages',name,'package.json'),JSON.stringify({name:'@proof-or-stop/'+name,type:'module',main:'dist/index.js'}));fs.writeFileSync(join(root,'packages',name,'tsconfig.json'),JSON.stringify({compilerOptions:{target:'ES2022',module:'Node16',moduleResolution:'Node16',rootDir:'src',outDir:'dist',declaration:true,skipLibCheck:true},include:['src/**/*.ts']}));fs.writeFileSync(join(root,'packages',name,'src/index.ts'),'export const compilerFixture = 1;\n');}
 fs.mkdirSync(join(root,'packages/graph/scripts'));fs.writeFileSync(join(root,'packages/graph/scripts/build-web.mjs'),"import fs from 'node:fs';fs.mkdirSync('assets');fs.writeFileSync('assets/app.html','<!doctype html>');\n");
 fs.mkdirSync(join(root,'scripts'));fs.writeFileSync(join(root,'scripts/build-lock-target.mjs'),'export {};\n');
 fs.mkdirSync(join(root,'bin'));fs.writeFileSync(join(root,'bin/proof-or-stop.js'),"import '../packages/main/dist/cli.js';\n");fs.writeFileSync(join(root,'bin/bootstrap-runner.js'),'export {};\n');
 fs.writeFileSync(join(root,'packages/main/src/core/runtime.cjs'),'module.exports = 17;\n');
 fs.writeFileSync(join(root,'packages/main/src/tasks/runtime.cjs'),'module.exports = 18;\n');
 fs.writeFileSync(join(root,'proof-or-stop.config.json'),JSON.stringify({scanRoot:'packages/main',rootDir:'src',outDir:'packages/main/dist',managedReviewIsolation:{mode:'readonly-build',adapter:'prooforstop-main-v1'}}));

 const shim=join(bin,'codex');fs.writeFileSync(shim,`#!${process.execPath}\nconst fs=require('node:fs'),p=require('node:path');let denied=false;try{const file=p.join(process.cwd(),'packages/main/src/cli.ts'),bytes=fs.readFileSync(file);fs.writeFileSync(file,bytes);}catch(e){denied=['EPERM','EACCES'].includes(e.code);}let outputWritable=false;const output=process.env.PROOF_OR_STOP_REVIEW_BUILD_OUTPUT;if(output){const probe=p.join(output,'owned-probe');fs.writeFileSync(probe,'ok');fs.unlinkSync(probe);outputWritable=true;}console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'U08_CROSSHOST '+JSON.stringify({denied,outputWritable,cwd:process.cwd()})}}));process.exitCode=1;\n`,{mode:0o755});
 git(['init','-b','main']);git(['config','user.name','U08 Test']);git(['config','user.email','u08@example.test']);git(['add','.']);git(['commit','-m','isolated crosshost input']);
 const headHash=git(['rev-parse','HEAD']);snapshotParent=fs.realpathSync(fs.mkdtempSync(join(os.tmpdir(),'proof-or-stop-xhr-review-')));snapshot=join(snapshotParent,'worktree');git(['worktree','add','--detach',snapshot,headHash]);
 const submitted=await submitManagedHostRun({root,cwd:snapshot,host:'codex',storyId:'B-u08-crosshost',phase:'REVIEW',agentType:'cross-host-review:codex',profile:'cross_host_review_codex',promptText:'Actual local cross-host readonly isolation witness; return nonzero, never claim a review verdict.',timeoutMs:10000,deadlineMs:300000,projectRootHash:'sha256:fixture',environment:{CODEX_HOME:fixtureCodexHome,PATH:bin+':'+process.env.PATH,PROOF_OR_STOP_USAGE_LEDGER:'0'}},{claimTimeoutMs:2000,launchWorker:async request=>{workerStarts++;worker=runManagedHostRunWorker(request,{env:process.env});return {pid:process.pid};}});
 const terminal=await worker,dir=managedHostRunDirectory(root,submitted.runId);
 const live=fs.readFileSync(join(dir,'live-output.jsonl'),'utf8');const text=live.trim().split('\n').map(line=>JSON.parse(line).text??'').join('');
 const observations=text.trim().split('\n').map(line=>{try{return JSON.parse(line).item?.text;}catch{return undefined;}}).filter(Boolean);
 const observation=JSON.parse(observations.find(line=>line.startsWith('U08_CROSSHOST ')).slice('U08_CROSSHOST '.length));
 console.log('actual-crosshost',JSON.stringify({observation,terminal:terminal.reason,workerStarts}));
 assert.equal(workerStarts,1);assert.equal(observation.cwd,snapshot);
 assert.equal(observation.denied,true,'actual cross_host_review_codex provider source write/restore must be denied');
 assert.equal(observation.outputWritable,true,'actual crosshost provider must have its private build output');
 assert.equal(terminal.reason,'exit_nonzero');assert.equal(readManagedHostRunBinding(root,submitted.runId).cwd,snapshot);
 console.log('PASS actual crosshost managed submit -> worker -> default provider readonly source and private output');
} finally {if(worker)await worker.catch(()=>{});if(snapshot){try{git(['worktree','remove','--force',snapshot]);}catch{}}if(snapshotParent)fs.rmSync(snapshotParent,{recursive:true,force:true});os.userInfo=originalUserInfo;syncBuiltinESMExports();fs.rmSync(base,{recursive:true,force:true});}
