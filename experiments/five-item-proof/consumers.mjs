#!/usr/bin/env node
import assert from 'node:assert/strict';
import {execFileSync,spawnSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {performance} from 'node:perf_hooks';
const here=dirname(fileURLToPath(import.meta.url)),root=resolve(here,'../..');
const {StoryStore}=await import('../../packages/main/dist/core/store.js');
const {listRuntimeArtifactIgnorePatterns}=await import('../../packages/main/dist/core/runtime-artifact-registry.js');
const {persistSyntheticAdmittedWindowForTest}=await import('../../packages/main/dist/core/certification-window.js');
const {deriveCertificationDomainInputHashes}=await import('../../packages/main/dist/handlers/certification-window.js');
const {resetConfigCache}=await import('../../packages/main/dist/core/config.js');
const output=process.env.FIVE_ITEM_PROOF_OUTPUT||join(tmpdir(),'five-consumers-'+Date.now());mkdirSync(output,{recursive:true});
const pairs=Number(process.env.FIVE_ITEM_PAIRS||5),trials=[],negative=process.env.FIVE_ITEM_NEGATIVE||'';
for(let pair=1;pair<=pairs;pair++)for(const mode of pair%2?['RED','GREEN']:['GREEN','RED']){
 const fixture=mkdtempSync(join(tmpdir(),'pos-consumers-')),log=join(output,`${pair}-${mode}-executions.jsonl`);
 const git=a=>execFileSync('git',a,{cwd:fixture,encoding:'utf8',stdio:['pipe','pipe','pipe']}).trim();
 const write=(p,v)=>{mkdirSync(dirname(join(fixture,p)),{recursive:true});writeFileSync(join(fixture,p),v);};
 try{
 const commands=['alpha','beta'].map(name=>({label:name,command:process.execPath,args:['witness.mjs',name],timeoutMs:30000,env:{LAB_EXEC_LOG:log},resources:[{class:'fixed-path',key:'.',access:'shared'}],...(mode==='GREEN'?{executionReuse:'exact-inputs',executionInputs:[]}:{} )}));
 write('proof-or-stop.config.json',JSON.stringify({scanRoot:'.',rootDir:'src',storyDir:'.proof-or-stop/story/actives',requirementsDir:'docs/requirements',validate:{dynamic:{mode:'off'},commands},doneRequiredCommands:commands}));
 write('packages/main/package.json',JSON.stringify({name:'@proof-or-stop/core',version:'0.0.0-fixture'}));write('src/add.mjs','export const add=(a,b)=>a+b;\n');
 write('.gitignore',listRuntimeArtifactIgnorePatterns().join('\n')+'\n');
 write('witness.mjs',"import assert from 'node:assert/strict';import {appendFileSync} from 'node:fs';import {randomUUID} from 'node:crypto';import {add} from './src/add.mjs';const cases=[[1,2,3],[-1,1,0],[0,0,0]];for(const [a,b,c] of cases)assert.equal(add(a,b),c);const until=Date.now()+350;let n=0;while(Date.now()<until)n=Math.imul(n+1,17);const id=randomUUID();appendFileSync(process.env.LAB_EXEC_LOG,JSON.stringify({id,command:process.argv[2],caseCount:cases.length,pid:process.pid})+'\\n');console.log('WITNESS '+id+' CASES 3 PASS');\n");
 git(['init','-q','-b','story/B-labconsumer']);git(['config','user.email','lab@example.test']);git(['config','user.name','Lab fixture']);git(['add','.']);git(['commit','-qm','code']);git(['branch','main']);resetConfigCache();
 const store=new StoryStore(fixture),storyId='B-labconsumer';store.writeStory(storyId,{storyId,name:'real-consumer-fixture',title:'Both real consumers retain coverage',description:'Isolated integration fixture',type:'chore',phase:'TEST',priority:'medium',createdAt:new Date().toISOString(),startedAt:new Date().toISOString(),endedAt:null});store.writeChecklist(storyId,{items:[]});persistSyntheticAdmittedWindowForTest({store,storyId,projectRoot:fixture,causalInputHashes:deriveCertificationDomainInputHashes(fixture,'HEAD',fixture)});git(['add','.']);git(['commit','-qm','fixture state']);
 const started=performance.now(),runs=[];
 for(const kind of ['routine','done']){
  const target=join(output,`${pair}-${mode}-${kind}.json`);const r=spawnSync(process.execPath,[join(here,'consumer-worker.mjs'),kind,fixture,target],{cwd:fixture,encoding:'utf8',timeout:90000,env:{...process.env,PROOF_OR_STOP_SESSION_ID:'five-consumer-fixture',FIVE_ITEM_NEGATIVE:mode==='GREEN'?negative:''}});
  writeFileSync(join(output,`${pair}-${mode}-${kind}.log`),r.stdout+r.stderr);assert.equal(r.status,0,r.stdout+r.stderr);
  const body=JSON.parse(readFileSync(target,'utf8'));if(kind==='routine')assert.equal(body.allPass,true,JSON.stringify(body));else if(negative&&mode==='GREEN'){assert.equal(body.status,'fail');assert.match(body.refusalReasons.join(' '),/SHARED_DONE_REQUIRES_CLEAN_WORKSPACE/);}else {assert.equal(body.status,'PASS',JSON.stringify(body));assert.equal(body.receipts.length,2);assert.ok(body.receipts.every(x=>x.exitCode===0));}runs.push(body);
 }
 const executions=readFileSync(log,'utf8').trim().split('\n').map(JSON.parse);assert.equal(executions.length,mode==='GREEN'?2:4,'wrong actual child count');assert.ok(executions.every(x=>x.caseCount===3));
 trials.push({pair,mode,elapsedMs:performance.now()-started,executionCount:executions.length,coverageDemands:12,successfulConsumers:negative&&mode==='GREEN'?1:2,negative,runs});
 console.log(mode+' pair '+pair+' executions='+executions.length+(negative&&mode==='GREEN'?' dirty input refused before DONE child launch':' both real consumers accepted'));
 }catch(e){writeFileSync(join(output,'failure.json'),JSON.stringify({pair,mode,error:String(e.stack),fixture},null,2));throw e;}
 finally{rmSync(fixture,{recursive:true,force:true});resetConfigCache();}
}
writeFileSync(join(output,'consumer-trials.json'),JSON.stringify({negative,trials,limitations:['real handlers and persisted StoryStore receipts; fixture admission is synthetic and grants no real Story authority','dynamic off with complete unchanged 6-case corpus; not proof that the root 134-command observe configuration benefits','forbidden/build-proof controls remain in production-mechanisms regression; this workload is eligible by construction']},null,2));
console.log(negative?'REAL_CONSUMER_NEGATIVE_PASS':'REAL_CONSUMERS_GREEN');
