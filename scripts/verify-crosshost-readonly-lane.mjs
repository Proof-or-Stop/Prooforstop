import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import {join,dirname} from 'node:path';import {execFileSync} from 'node:child_process';import {pathToFileURL,fileURLToPath} from 'node:url';import {syncBuiltinESMExports} from 'node:module';
const repo=fs.realpathSync(process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : fileURLToPath(new URL('..',import.meta.url))),base=fs.realpathSync(fs.mkdtempSync(join(os.tmpdir(),'u08-real-worker-'))),root=join(base,'project'),bin=join(base,'bin');fs.mkdirSync(root);fs.mkdirSync(bin);const fixtureCodexHome=join(base,'codex-home');fs.mkdirSync(fixtureCodexHome);fs.writeFileSync(join(fixtureCodexHome,'auth.json'),JSON.stringify({auth_mode:'apikey',OPENAI_API_KEY:'fixture-not-a-real-key'}),{mode:0o600});
const originalUserInfo=os.userInfo;os.userInfo=(...args)=>({...originalUserInfo(...args),homedir:base});syncBuiltinESMExports();
const load=p=>import(pathToFileURL(join(repo,'packages/main/dist',p)).href);
const {prepareManagedSingletonAdmission,bindManagedSingletonSubmission}=await load('core/managed-launch-admission.js');
const {materializeHostRunLaunch}=await load('core/host-run.js');
const unconfinedLaunch=materializeHostRunLaunch({host:'codex',launchProfile:'cross_host_review_codex',cwd:root,root,promptText:'Unconfined profile must retain provider read-only mode.',env:{},storyId:null,agentType:'fixture',recordedAt:new Date().toISOString(),projectRootHash:'fixture'});
assert.equal(unconfinedLaunch.argv[unconfinedLaunch.argv.indexOf('-s')+1],'read-only','Unconfined cross-host calls retain the provider sandbox');
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

 const shim=join(bin,'codex'),witness=join(bin,'readonly-witness.cjs');fs.writeFileSync(witness,`#!${process.execPath}\nconst fs=require('node:fs'),p=require('node:path');const argv=process.argv.slice(2),innerSandbox=argv[argv.indexOf('-s')+1];let sourceReadable=false;try{sourceReadable=fs.readFileSync(p.join(process.cwd(),'packages/main/src/cli.ts'),'utf8').includes('actualCompilerInput');}catch{}let denied=false;try{const file=p.join(process.cwd(),'packages/main/src/cli.ts'),bytes=fs.readFileSync(file);fs.writeFileSync(file,bytes);}catch(e){denied=['EPERM','EACCES'].includes(e.code);}let outputWritable=false;const output=process.env.PROOF_OR_STOP_REVIEW_BUILD_OUTPUT;if(output){const probe=p.join(output,'owned-probe');fs.writeFileSync(probe,'ok');if(!${process.argv.includes('--output-tamper')})fs.unlinkSync(probe);outputWritable=true;}console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'U08_CROSSHOST '+JSON.stringify({denied,sourceReadable,innerSandbox,outputWritable,cwd:process.cwd()})}}));process.exitCode=1;\n`,{mode:0o755});
 // The production admission requires a native executable, not a shebang shim.
 // This disposable native fixture distinguishes the actual supervised readiness
 // probe from the worker witness; neither output is a real reviewer verdict.
 const nativeSource=join(bin,'provider.c');
 fs.writeFileSync(nativeSource,`#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
int main(int argc,char **argv){
 if(argc>1 && strcmp(argv[1],"--version")==0){puts("codex-cli readonly-fixture 1.0.0");return 0;}
 char prompt[131072];size_t used=0;int ch;while((ch=getchar())!=EOF){if(used+1>=sizeof(prompt))return 74;prompt[used++]=(char)ch;}prompt[used]=0;
 if(strstr(prompt,"Actual local cross-host readonly isolation witness")){
  char **child=calloc((size_t)argc+2,sizeof(char*));if(!child)return 75;
  child[0]=${JSON.stringify(process.execPath)};child[1]=${JSON.stringify(witness)};for(int i=1;i<argc;i++)child[i+1]=argv[i];execv(child[0],child);perror("fixture exec");return 76;
 }
 puts("READY");return 0;
}
`);
 execFileSync('cc',[nativeSource,'-o',shim],{stdio:'pipe'});
 git(['init','-b','main']);git(['config','user.name','U08 Test']);git(['config','user.email','u08@example.test']);git(['add','.']);git(['commit','-m','isolated crosshost input']);
 const headHash=git(['rev-parse','HEAD']);snapshotParent=fs.realpathSync(fs.mkdtempSync(join(os.tmpdir(),'proof-or-stop-xhr-review-')));snapshot=join(snapshotParent,'worktree');git(['worktree','add','--detach',snapshot,headHash]);
 const environment={CODEX_HOME:fixtureCodexHome,PATH:bin+':'+process.env.PATH,PROOF_OR_STOP_USAGE_LEDGER:'0'};
 const deriveSubjectIdentity=()=>git(['rev-parse','HEAD']);
 const admission=await prepareManagedSingletonAdmission({root,storyId:'B-u08-crosshost',profile:'cross_host_review_codex',lane:'cross-host-review:codex',host:'codex',subjectIdentity:deriveSubjectIdentity(),deriveSubjectIdentity,effectiveBaseEnvironment:{...process.env,...environment}});
 const submitted=await submitManagedHostRun(bindManagedSingletonSubmission({root,cwd:snapshot,host:'codex',storyId:'B-u08-crosshost',phase:'REVIEW',agentType:'cross-host-review:codex',profile:'cross_host_review_codex',promptText:'Actual local cross-host readonly isolation witness; return nonzero, never claim a review verdict.',timeoutMs:10000,deadlineMs:300000,projectRootHash:'sha256:fixture',environment},admission),{claimTimeoutMs:2000,launchWorker:async request=>{workerStarts++;worker=runManagedHostRunWorker(request,{env:process.env});return {pid:process.pid};}});
 const terminal=await worker,dir=managedHostRunDirectory(root,submitted.runId);
 const live=fs.readFileSync(join(dir,'live-output.jsonl'),'utf8');const text=live.trim().split('\n').map(line=>JSON.parse(line).text??'').join('');
 const observations=text.trim().split('\n').map(line=>{try{return JSON.parse(line).item?.text;}catch{return undefined;}}).filter(Boolean);
 const observation=JSON.parse(observations.find(line=>line.startsWith('U08_CROSSHOST ')).slice('U08_CROSSHOST '.length));
 console.log('actual-crosshost',JSON.stringify({observation,terminal:terminal.reason,workerStarts}));
 assert.equal(workerStarts,1);assert.equal(observation.cwd,snapshot);
 assert.equal(observation.denied,true,'actual cross_host_review_codex provider source write/restore must be denied');
 assert.equal(observation.outputWritable,true,'actual crosshost provider must have its private build output');
 assert.equal(observation.sourceReadable,true,'actual outer sandbox must allow source reads');
 assert.equal(observation.innerSandbox,'danger-full-access','CROSSHOST_NESTED_SANDBOX: sealed outer readonly lane must not request a second provider sandbox');
 if(process.argv.includes('--output-tamper'))assert.match(terminal.reason,/managed readonly compiled output differs from sealed build/);else assert.equal(terminal.reason,'exit_nonzero');assert.equal(readManagedHostRunBinding(root,submitted.runId).cwd,snapshot);
 console.log('PASS actual crosshost managed submit -> worker -> default provider readonly source and private output');
} finally {if(worker)await worker.catch(()=>{});if(snapshot){try{git(['worktree','remove','--force',snapshot]);}catch{}}if(snapshotParent)fs.rmSync(snapshotParent,{recursive:true,force:true});os.userInfo=originalUserInfo;syncBuiltinESMExports();fs.rmSync(base,{recursive:true,force:true});}
