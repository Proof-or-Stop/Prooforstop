#!/usr/bin/env node
import assert from 'node:assert/strict';
import {execFileSync, spawn} from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync,rmSync,chmodSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
const repo=resolve(fileURLToPath(new URL('..',import.meta.url)));
const {StoryStore}=await import('../packages/main/dist/core/store.js');
const {acquireOwnerLease,getSessionId}=await import('../packages/main/dist/core/story-owner-lease.js');
const scenario=process.argv.find(a=>a.startsWith('--scenario='))?.split('=')[1]??'preexisting';
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
 store.writeStory(storyId,{storyId,name:'closeout-proof',title:'Closeout proof',description:'Disposable Lab fixture, not formal lifecycle evidence.',type:'chore',phase:'TEST',priority:'medium',createdAt:now,startedAt:now,endedAt:null});
 store.writeChecklist(storyId,{items:[]});
 store.appendProcessEvent(storyId,{type:'human_confirmation',storyId,reason:'seed event'});
 git(['add','.']);git(['add',...['story.json','checklist.json','process-events.jsonl'].filter(f=>existsSync(join(store.storyDirPath(storyId),f))).map(f=>join(store.storyDirPath(storyId),f))]);git(['commit','-qm','seed immutable Lab fixture']);
 acquireOwnerLease(store.storyDirPath(storyId),{command:'validate',cwd:root});
 const env={...process.env,PROOF_OR_STOP_SESSION_ID:getSessionId()};
 if(scenario==='event-tamper'){
  const preload=join(outside,'event-inject.mjs');
  writeFileSync(preload,`import {StoryStore} from ${JSON.stringify(join(repo,'packages/main/dist/core/store.js'))};import {appendFileSync} from 'node:fs';const original=StoryStore.prototype.appendProcessEvent;StoryStore.prototype.appendProcessEvent=function(id,event){if(event.type==='validation_terminal')appendFileSync(this.storyFilePath(id,'process-events.jsonl'),JSON.stringify({type:'human_confirmation',storyId:id,reason:'FOREIGN_EVENT',timestamp:new Date().toISOString()})+'\\n');return original.call(this,id,event);};`);
  env.NODE_OPTIONS=[env.NODE_OPTIONS??'', '--import='+preload].join(' ').trim();
 }
 if(scenario==='evidence-tamper'||scenario==='terminal-read-failure'){
  const preload=join(outside,'inject.mjs');
  const mutation=scenario==='evidence-tamper'
   ? `const p=this.storyFilePath(id,'test-evidence.json');const foreign=JSON.parse(readFileSync(p,'utf8'));foreign.output='FOREIGN_PAYLOAD';writeFileSync(p,JSON.stringify(foreign,null,2)+'\\n');`
   : `const read=this.readStory.bind(this);let pending=true;this.readStory=(...args)=>{if(pending){pending=false;throw new Error('INJECTED_TERMINAL_READ_FAILURE');}return read(...args);};`;
  writeFileSync(preload,`import {StoryStore} from ${JSON.stringify(join(repo,'packages/main/dist/core/store.js'))};import {readFileSync,writeFileSync} from 'node:fs';const original=StoryStore.prototype.writeTestEvidence;StoryStore.prototype.writeTestEvidence=function(id,data){const result=original.call(this,id,data);${mutation}return result;};`);
  env.NODE_OPTIONS=[env.NODE_OPTIONS??'', '--import='+preload].join(' ').trim();
 }
 if(scenario==='status-error'){
  const fakeGit=join(outside,'git');
  writeFileSync(fakeGit,'#!/bin/sh\ncase "$*" in *"--no-optional-locks status --porcelain --"*test-evidence.json*) echo LAB_STATUS_PROBE_FAILURE >&2; exit 73;; esac\nexec /usr/bin/git "$@"\n');
  chmodSync(fakeGit,0o755);env.PATH=outside+':'+env.PATH;
 }
 const append=()=>store.appendProcessEvent(storyId,{type:'human_confirmation',storyId,reason:'concurrent closeout observation'});
 if(scenario==='preexisting')append();
 if(scenario==='owner-fence'){
  const preload=join(outside,'fence-inject.mjs');
  writeFileSync(preload, `import {registerHooks} from 'node:module';registerHooks({load(url,context,next){const r=next(url,context);if(url.endsWith('/core/validation-execution-lock.js')){const source=String(r.source);const needle='export function assertCurrentValidationPublicationOwner(root, storyId) {';if(!source.includes(needle))throw new Error('FENCE_INJECTION_TARGET_MISSING');return {...r,source:source.replace(needle,needle+" throw new Error('[VALIDATION_PUBLICATION_OWNER_LOST] injected publication boundary failure');")};}return r;}});`);
  env.NODE_OPTIONS=[env.NODE_OPTIONS??'', '--import='+preload].join(' ').trim();
 }
 const start=performance.now();
 const run = async (inject=false) => {
  const cp=spawn(process.execPath,[join(repo,'bin/proof-or-stop.js'),'--root',root,'validate',JSON.stringify({storyId,dynamicMode:'off',json:true,noSync:true})],{cwd:root,env,stdio:['ignore','pipe','pipe']});
  let stdout='',stderr='',injected=false,writerError=null;
  cp.stdout.on('data',b=>stdout+=b);cp.stderr.on('data',b=>stderr+=b);
  const timer=setInterval(()=>{
   if(inject&&!injected&&existsSync(join(outside,'running'))){
    injected=true;
    try {
     if(scenario==='source-drift')writeFileSync(join(root,'witness.mjs'),readFileSync(join(root,'witness.mjs'),'utf8')+'// changed during validation\n');
     else append();
    }catch(error){writerError=String(error.message);}
   }
  },10);
  const kill=setTimeout(()=>cp.kill('SIGTERM'),suite?150000:45000);
  let status;
  try {status=await new Promise((res,rej)=>{cp.on('error',rej);cp.on('close',res);});}
  finally {clearInterval(timer);clearTimeout(kill);}
  let result=null;try{result=JSON.parse(stdout);}catch{}
  return {status,injected,writerError,stdout,stderr,result};
 };
 const first=await run(scenario==='concurrent'||scenario==='source-drift');
 const firstElapsedMs=performance.now()-start;
 const count=()=>existsSync(join(outside,'starts'))?readFileSync(join(outside,'starts'),'utf8').trim().split('\n').length:0;
 const firstExecutions=count();
 const firstEvidence=store.readTestEvidence(storyId);
 let retry=null;
 if(scenario==='preexisting'||scenario==='concurrent'){
  // The test operator resolves its own pending event. This is not production
  // auto-commit or permission to adopt unrelated dirty paths.
  if(first.writerError)append();
  git(['add',join(store.storyDirPath(storyId),'process-events.jsonl')]);
  git(['commit','-qm','record the fixture operator event']);
  retry=await run();
 }
 const eventCount=store.readProcessEvents(storyId).filter(e=>e.reason==='concurrent closeout observation').length;
 let committedEvidence=null;try{committedEvidence=JSON.parse(git(['show','HEAD:'+join('.proof-or-stop/story/actives',storyId,'test-evidence.json')]));}catch{}
 const summary={committedEvidence,events:store.readProcessEvents(storyId),scenario,workMs,suite,firstElapsedMs,elapsedMs:performance.now()-start,firstExecutions,executions:count(),first,retry,eventCount,firstEvidence,evidence:store.readTestEvidence(storyId),gitStatus:git(['status','--porcelain'])};
 console.log(JSON.stringify(summary,null,2));
 if(process.env.CLOSEOUT_OUTPUT)writeFileSync(process.env.CLOSEOUT_OUTPUT,JSON.stringify(summary,null,2));
 if(!process.argv.includes('--observe')){
  if(scenario==='preexisting'){
   assert.equal(firstExecutions,0,'CLOSEOUT_PREFLIGHT_LATE: dirty publication metadata must refuse before child launch');
   assert.match(first.stdout+first.stderr,/VALIDATION_PUBLICATION_NOT_READY/);
   assert.equal(first.result?.allPass,false);
   assert.equal(first.result?.commandExecutions,0);
   assert.equal(firstEvidence,null,'No early refusal may publish PASS');
  }else if(scenario==='concurrent'){
   assert.equal(first.result?.allPass,true,'CLOSEOUT_CONCURRENT_WRITE_INVALIDATED_PASS');
   assert.equal(firstEvidence?.result,'PASS','CLOSEOUT_CANONICAL_EVIDENCE_MISSING');
   assert.match(first.writerError??'',/VALIDATION_METADATA_BUSY/,'concurrent writer must receive an explicit retryable refusal');
  }else if(scenario==='event-tamper'){
   assert.equal(first.result?.allPass,false,'FOREIGN_EVENT_MUST_REFUSE_PUBLICATION');
   assert.equal(summary.events.filter(event=>event.reason==='FOREIGN_EVENT').length,1,'FOREIGN_EVENT_MUST_BE_PRESERVED');
   assert.notEqual(summary.committedEvidence?.result,'PASS');
  }else if(scenario==='evidence-tamper'||scenario==='terminal-read-failure'){
   assert.equal(firstExecutions,1,'injection must reach the real execution path');
   assert.equal(first.result?.allPass,false,'PUBLICATION_MUST_REJECT_'+scenario);
   assert.notEqual(summary.committedEvidence?.output,'FOREIGN_PAYLOAD','Foreign evidence cannot be committed as canonical');
   assert.notEqual(summary.committedEvidence?.result,'PASS','Partial publication cannot commit PASS');
   if(scenario==='evidence-tamper') assert.equal(summary.evidence?.output,'FOREIGN_PAYLOAD','Foreign evidence bytes must remain on disk');
   if(scenario==='terminal-read-failure'){assert.notEqual(summary.evidence?.result,'PASS','Failed terminal publication rolls back own evidence');assert.match(first.stdout,/VALIDATION_TERMINAL_RECEIPT_MISSING/,'Missing terminal receipt must be refused directly');}
  }else if(scenario==='status-error'){
   assert.equal(first.result?.allPass,false,'PROBE_ERROR_MUST_BE_STRUCTURED_FAILURE');
   assert.equal(firstExecutions,0);assert.equal(first.result?.commandExecutions,0);
   assert.match(first.stdout,/LAB_STATUS_PROBE_FAILURE/);
  }else if(scenario==='source-drift'){
   assert.equal(first.result?.allPass,false,'SOURCE_DRIFT_MUST_NOT_PASS');
   assert.notEqual(summary.evidence?.result,'PASS');
  }else if(scenario==='owner-fence'){assert.equal(firstExecutions,1);assert.equal(first.result?.allPass,false);assert.equal(firstEvidence,null);assert.match(first.stdout,/VALIDATION_PUBLICATION_OWNER_LOST/);}
  else assert.equal(first.result?.allPass,true,'CLEAN_CONTROL_MUST_PASS');
  if(retry){
   assert.equal(retry.result?.allPass,true,'RETRY_MUST_PUBLISH_CURRENT_PASS');
   assert.equal(summary.evidence?.result,'PASS');
   assert.equal(summary.executions,1,'RECOVERY_MUST_NOT_REPEAT_VALIDATION');
   assert.equal(eventCount,1,'Pending event must be recorded exactly once');
   assert.equal(summary.gitStatus,'','Recovery must leave canonical transaction clean');
  }
 }

} finally {rmSync(root,{recursive:true,force:true});rmSync(outside,{recursive:true,force:true});}
