#!/usr/bin/env node
import assert from 'node:assert/strict';
import {execFileSync, spawn} from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync,rmSync,chmodSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
const repo=process.cwd();
const {StoryStore}=await import(resolve(repo,'packages/main/dist/core/store.js'));
const {acquireOwnerLease,getSessionId}=await import(resolve(repo,'packages/main/dist/core/story-owner-lease.js'));
const valid=process.argv.includes('--valid'),legacy=process.argv.includes('--legacy'),corrupt=process.argv.includes('--corrupt');
const phase=process.argv.find(a=>a.startsWith('--phase='))?.slice(8)??'TEST';
const noStory=process.argv.includes('--no-story');
const omitted=process.argv.includes('--omitted');
const violation=process.argv.includes('--violation');
const shadow=process.argv.includes('--shadow');
const reuseMissing=process.argv.includes('--reuse-missing');
const dirty=process.argv.includes('--dirty');
const root=mkdtempSync(join(tmpdir(),'pos-closeout-'));
const outside=mkdtempSync(join(tmpdir(),'pos-closeout-observer-'));
const git=argv=>execFileSync('git',argv,{cwd:root,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
const storyId='B-closeout-proof',now=new Date().toISOString();
const workMs=Number(process.env.CLOSEOUT_WORK_MS??1000);
const suite=process.env.CLOSEOUT_SUITE??null;
const reports=[];
try {
 git(['init','-q','-b','main']);git(['config','user.name','Lab Proof']);git(['config','user.email','lab@example.invalid']);
 writeFileSync(join(root,'.gitignore'),readFileSync(join(repo,'.gitignore')));
 mkdirSync(join(root,'packages/main'),{recursive:true});writeFileSync(join(root,'packages/main/package.json'),readFileSync(join(repo,'packages/main/package.json')));
 writeFileSync(join(root,'witness.mjs'),`import {appendFileSync,writeFileSync} from 'node:fs';appendFileSync(${JSON.stringify(join(outside,'starts'))},'start\\n');writeFileSync(${JSON.stringify(join(outside,'running'))},'running');await new Promise(r=>setTimeout(r,${workMs}));${suite?`const {execFileSync}=await import('node:child_process');execFileSync(process.execPath,[${JSON.stringify(suite)}],{stdio:'inherit'});`:''}console.log('CLOSEOUT_WITNESS_PASS');\n`);
 writeFileSync(join(root,'proof-or-stop.config.json'),JSON.stringify({scanRoot:'.',rootDir:'src',storyDir:'.proof-or-stop/story/actives',validate:{dynamic:{mode:'off'},commands:[{label:'closeout witness',command:process.execPath,args:['witness.mjs'],timeoutMs:suite?120000:10000}]}}));
 const store=new StoryStore(root);
 store.writeStory(storyId,{storyId,name:'closeout-proof',title:'Closeout proof',description:'Disposable Lab fixture, not formal lifecycle evidence.',type:'chore',phase,priority:'medium',createdAt:now,startedAt:now,endedAt:null});
 store.writeChecklist(storyId,{items:[{id:'CHK-001',title:'Verify declared witness scope',status:'done',verificationIntent:{happy:[{desc:'Routine scope witness',type:'logic',priority:'should'}],edge:[],adversarial:[]},...(omitted?{}:{files:legacy?{modify:[],create:[],test:[]}:{modify:['witness.mjs'],create:[],test:[]}})}]});
 if(valid||violation||reuseMissing||shadow){const {createScopeContractHandlers}=await import(resolve(repo,'packages/main/dist/handlers/scope-contract.js'));createScopeContractHandlers({root,store,log:()=>{}}).scope_contract_set({storyId,mode:shadow?'shadow':'enforce',allowedModify:['witness.mjs']});}
 if(corrupt)writeFileSync(store.storyFilePath(storyId,'scope-contract.json'),'{corrupt');
 store.appendProcessEvent(storyId,{type:'human_confirmation',storyId,reason:'seed event'});
 git(['add','.']);git(['add',...['story.json','checklist.json','process-events.jsonl','scope-contract.json'].filter(f=>existsSync(join(store.storyDirPath(storyId),f))).map(f=>join(store.storyDirPath(storyId),f))]);git(['commit','-qm','seed immutable Lab fixture']);
 if(valid&&!violation&&!shadow){git(['checkout','-qb','fixture-valid-scope']);writeFileSync(join(root,'witness.mjs'),readFileSync(join(root,'witness.mjs'),'utf8')+'// in-scope positive change\n');git(['add','witness.mjs']);git(['commit','-qm','valid in-scope change']);}
 if(violation){git(['checkout','-qb','fixture-scope']);writeFileSync(join(root,'outside.mjs'),'// out of scope');git(['add','outside.mjs']);git(['commit','-qm','out of scope change']);}
 const {persistSyntheticAdmittedWindowForTest}=await import(resolve(repo,'packages/main/dist/core/certification-window.js'));
 const {deriveCertificationDomainInputHashes}=await import(resolve(repo,'packages/main/dist/handlers/certification-window.js'));
 const causalInputHashes=deriveCertificationDomainInputHashes(root,'HEAD',root);assert(causalInputHashes);
 persistSyntheticAdmittedWindowForTest({store,storyId,projectRoot:root,causalInputHashes});
 git(['add',store.storyFilePath(storyId,'certification-window.json')]);git(['commit','-qm','bind fixture certification precondition']);
 acquireOwnerLease(store.storyDirPath(storyId),{command:'validate',cwd:root});
 const env={...process.env,PROOF_OR_STOP_SESSION_ID:getSessionId(),...(process.argv.includes('--codex')?{PROOF_OR_STOP_ACTIVITY_SOURCE:'codex'}:{})};
 if(reuseMissing){const before=JSON.parse(execFileSync(process.execPath,[join(repo,'bin/proof-or-stop.js'),'--root',root,'validate',JSON.stringify({storyId,json:true,noSync:true})],{cwd:root,env,encoding:'utf8',stdio:['ignore','pipe','pipe']}));assert.equal(before.allPass,true);rmSync(store.storyFilePath(storyId,'scope-contract.json'));}
 if(dirty)store.appendProcessEvent(storyId,{type:'human_confirmation',storyId,reason:'pending operator record'});
 const cp=spawn(process.execPath,[join(repo,'bin/proof-or-stop.js'),'--root',root,'validate',JSON.stringify({...(!noStory?{storyId}:{}),json:!process.argv.includes('--text'),noSync:true})],{cwd:root,env,stdio:['ignore','pipe','pipe']});
 let stdout='',stderr='';cp.stdout.on('data',b=>stdout+=b);cp.stderr.on('data',b=>stderr+=b);const status=await new Promise((res,rej)=>{cp.on('error',rej);cp.on('close',res)});
 const starts=existsSync(join(outside,'starts'))?(readFileSync(join(outside,'starts'),'utf8').match(/start/g)?.length??0):0;
 const events=store.readProcessEvents(storyId).filter(e=>e.type==='codex_cli'&&e.command==='validate');console.log(JSON.stringify({status,starts,stdout,stderr,events,valid:process.argv.includes('--valid')},null,2));if(process.argv.includes('--codex')&&!valid){assert.equal(events.length,1,'one terminal failure event');assert.equal(events[0].result,'fail','REFUSAL_MUST_NOT_RECORD_TERMINAL_PASS');}
 if(valid||legacy||omitted||phase==='DEV'||noStory||shadow){assert.equal(starts,1,'Valid scope and compatibility must allow execution');if(!process.argv.includes('--text'))assert.equal(JSON.parse(stdout).allPass,true,'Valid control must publish PASS');}
 else{assert.equal(starts,reuseMissing?1:0,'SCOPE_PREREQUISITES_MUST_REFUSE_BEFORE_VALIDATION');assert.match(stdout+stderr,corrupt?/scope_contract_unreadable/:violation?/scope_contract_failed/:/missing_scope_contract/);if(!reuseMissing)assert.equal(store.readTestEvidence(storyId),null,'Prerequisite refusal must not publish evidence');else assert.equal(JSON.parse(stdout).commandExecutions,0,'Refusal cannot republish a prior result');}
 assert.equal(status,valid||legacy||omitted||phase==='DEV'||noStory||shadow?0:1,'VALIDATION_REFUSAL_MUST_EXIT_NONZERO');console.log('VALIDATION_EXIT_GREEN');
}finally{rmSync(root,{recursive:true,force:true});rmSync(outside,{recursive:true,force:true});}
