/** Disposable native CLI setup for validation-lock integration tests. */
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {StoryStore} from '../core/store.js';
import {loadVerifiedCertificationWindow} from '../core/certification-window.js';
import {deriveAdapterOwnerSessionId} from '../core/owner-session-adapters.js';
import {readOwnerLease,releaseOwnerLease} from '../core/story-owner-lease.js';
import {listRuntimeArtifactIgnorePatterns} from '../core/runtime-artifact-registry.js';
import {PROOF_OR_STOP_CONFIG_FILENAME} from '../core/brand-paths.js';
import {PROOF_OR_STOP_STORY_DIR} from '../core/proof-or-stop-paths.js';
import {sanitizedFixtureChildEnvironment} from './fixture-environment.js';
import {nativeReviewFixtureAmbientHost,nativeReviewFixtureBrokers,runBrokeredNativeReviewCli} from './native-review-fixture.js';

const cliPath=fileURLToPath(new URL('../cli.js',import.meta.url));
const roots=new Set<string>();
export function assertNativeLockFixture(root:string):void {assert(roots.has(root),'native setup can only operate on its own newly allocated disposable roots');}
export function lockFixtureActorEnvironment(agent:string) {
 const provider=nativeReviewFixtureAmbientHost()==='claude'?'claude-code' as const:'codex' as const;
 return {...sanitizedFixtureChildEnvironment(process.env),PROOF_OR_STOP_SESSION_ID:undefined,
  PROOF_OR_STOP_AGENT:agent,PROOF_OR_STOP_OWNER_SESSION_ADAPTER_PROVIDER:provider,
  PROOF_OR_STOP_OWNER_SESSION_ADAPTER_TASK:'native-lock:'+agent,PROOF_OR_STOP_OWNER_SESSION_ADAPTER_AGENT:agent};
}
export function lockFixtureCli(root:string,storyId:string,command:string,payload:Record<string,unknown>,agent='main'):string {
 assertNativeLockFixture(root);
 const env=lockFixtureActorEnvironment(agent),start=performance.now();
 try {
  return execFileSync(process.execPath,[cliPath,'--root',root,command,JSON.stringify(payload)],
   {cwd:root,env:{...env,PROOF_OR_STOP_PROJECT_ROOT:root},encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:60000,maxBuffer:16*1024*1024}).trim();
 } finally {
  const directory=new StoryStore(root).storyDirPath(storyId);
  const session=deriveAdapterOwnerSessionId(root,env.PROOF_OR_STOP_OWNER_SESSION_ADAPTER_PROVIDER,env.PROOF_OR_STOP_OWNER_SESSION_ADAPTER_TASK,agent);
  if(readOwnerLease(directory)?.sessionId===session)assert(releaseOwnerLease(directory));
  console.log('NATIVE_LOCK_SETUP_TIMING '+JSON.stringify({storyId,command,agent,elapsedMs:performance.now()-start}));
 }
}

export async function createNativeLockFixture(storyId:string,phase:'REVIEW'|'TEST'='TEST',routine=true) {
 assert(/^B-[A-Za-z0-9_-]+$/.test(storyId));
 const root=realpathSync(mkdtempSync(join(tmpdir(),'proof-or-stop-native-lock-')));roots.add(root);
 const store=new StoryStore(root),start=performance.now();
 const git=(...args:string[])=>execFileSync('git',args,{cwd:root,encoding:'utf8',stdio:['ignore','pipe','pipe'],
  env:{...process.env,GIT_AUTHOR_NAME:'Native lock fixture',GIT_AUTHOR_EMAIL:'fixture@example.test',GIT_COMMITTER_NAME:'Native lock fixture',GIT_COMMITTER_EMAIL:'fixture@example.test'}}).trim();
 const write=(file:string,text:string)=>{mkdirSync(dirname(join(root,file)),{recursive:true});writeFileSync(join(root,file),text);};
 const cli=(command:string,payload:Record<string,unknown>,agent='main')=>lockFixtureCli(root,storyId,command,payload,agent);
 try {
  write('.gitignore',[...listRuntimeArtifactIgnorePatterns(),'entered.log','release'].join('\n')+'\n');
  write('packages/main/src/index.ts','export const nativeLockSubject = true;\n');
  write('README.md','# Disposable native validation lock subject\n');
  write('validate-probe.mjs',`import {appendFileSync,existsSync} from 'node:fs';
appendFileSync('entered.log',(process.env.PROOF_OR_STOP_VALIDATE_LOCK_SMOKE_LABEL||'preparation')+' '+process.pid+' '+Date.now()+'\\n');
const deadline=Date.now()+8000;
while(!existsSync('release')){if(Date.now()>deadline)process.exit(12);await new Promise(r=>setTimeout(r,25));}
console.log('native lock probe passed');\n`);
  // These probes only touch their disposable repository; declare that footprint
  // so unrelated machine-wide validation is not a hidden prerequisite.
  const resources=[{class:'fixed-path' as const,key:'.',access:'exclusive' as const}];
  const probe={resources,label:'lock-probe',command:process.execPath,args:['validate-probe.mjs'],focus:['lock'],timeoutMs:10000};
  write(PROOF_OR_STOP_CONFIG_FILENAME,JSON.stringify({scanRoot:'packages/main',rootDir:'src',storyDir:PROOF_OR_STOP_STORY_DIR,requirementsDir:'docs/requirements',workflow:{profile:'light'},
   nativeReviewInvocation:{brokers:nativeReviewFixtureBrokers()},validate:{commands:[{resources,label:'cheap preparation',command:process.execPath,args:['--version'],focus:['fast'],timeoutMs:10000},probe]},doneRequiredCommands:[probe]},null,2));
  write('release','initial routine preparation\n');
  git('init','-b','main');
  const round=new Date().toISOString();
  // Initial subject data only. No review, PASS, window or admission records are fabricated.
  store.writeStory(storyId,{storyId,name:'native-lock-fixture',title:'Native lock fixture',description:'Disposable integration subject for the real CLI.',type:'bug',phase:'REVIEW',priority:'medium',createdAt:round,startedAt:round,endedAt:null,currentReviewRound:round,events:[{phase:'REVIEW',action:'advance',timestamp:round}]});
  store.writeChecklist(storyId,{items:[]});
  git('add','.');git('commit','-m','seed disposable lock subject');
  cli('review_inventory_begin',{storyId});
  const epoch=store.readReviewInventoryEpochs(storyId).epochs.at(-1)!;
  assert.equal(epoch.state,'OPEN');
  const files=git('ls-files').split('\n').filter(file=>file&&!file.startsWith('.proof-or-stop/'));
  for(const file of files)readFileSync(join(root,file));
  const readManifest={filesReadFully:files,filesTriagedByName:[],scanEscalationReason:null};
  const readEvents=files.map(path=>({path,mode:'full',action:'Read',tokenCount:null}));
  const terminal=async(agent:string,purpose:Record<string,unknown>={})=>{
   cli('dispatch',{storyId,agentType:agent,...purpose},agent);
   const output=cli('review_run_start',{storyId,agent,...purpose},agent);
   const reviewRunId=output.match(/Review run (\S+) started/)?.[1];assert(reviewRunId,output);
   const before=performance.now();
   try {await runBrokeredNativeReviewCli({root,store,storyId,agent,reviewRunId,command:'review_pass_set',env:{PROOF_OR_STOP_PROJECT_ROOT:root},payload:{storyId,agent,reviewRunId,note:'Disposable test actor read the complete subject and found no blocker.',readManifest,readEvents}});}
   finally {console.log('NATIVE_LOCK_SETUP_TIMING '+JSON.stringify({storyId,command:'review_pass_set',agent,elapsedMs:performance.now()-before}));}
   return reviewRunId;
  };
  for(const lane of epoch.requiredLanes)await terminal(lane);
  const agent='proof-or-stop-review-topology-critic';
  const reviewRunId=await terminal(agent,{reviewPurpose:'inventory-completeness',inventoryEpochId:epoch.epochId});
  cli('review_inventory_critic_set',{storyId,epochId:epoch.epochId,reviewRunId,agent,findingDispositions:[]},agent);
  cli('review_inventory_finalize',{storyId});
  const fast=JSON.parse(cli('validate',{storyId,focus:'fast',json:true}));
  assert.equal(fast.status,'pass');assert(fast.precertCheapCheckReceipt);
  assert.match(cli('certification_window_begin',{storyId}),/State: ADMITTED/);
  assert.equal(loadVerifiedCertificationWindow(store,storyId).window?.state,'ADMITTED');
  git('add','--',store.storyFilePath(storyId,'process-events.jsonl'));
  if(git('diff','--cached','--name-only'))git('commit','-m','record native lock admission events');
  if(routine)assert.equal(JSON.parse(cli('validate',{storyId,json:true})).status,'pass');
  else assert.equal(phase,'REVIEW','unconsumed admission stays in REVIEW');
  if(phase==='TEST')cli('story_advance',{storyId,phase:'TEST'});
  git('add','--',store.storyFilePath(storyId,'process-events.jsonl'));
  if(git('diff','--cached','--name-only'))git('commit','-m','publish native phase preparation events');
  assert.equal(git('status','--porcelain','--',store.storyFilePath(storyId,'process-events.jsonl')),'');
  assert.equal(store.readStory(storyId)?.phase,phase);
  if(routine)assert.equal(store.readTestEvidence(storyId)?.result,'PASS');
  else {assert.equal(store.readTestEvidence(storyId),null);assert.equal(loadVerifiedCertificationWindow(store,storyId).window?.state,'ADMITTED');}
  rmSync(join(root,'entered.log'),{force:true});rmSync(join(root,'release'));
  return {root,storyId,store,files};
 } catch(error){roots.delete(root);rmSync(root,{recursive:true,force:true});throw error;}
 finally {console.log('NATIVE_LOCK_SETUP_TOTAL '+JSON.stringify({storyId,elapsedMs:performance.now()-start}));}
}
