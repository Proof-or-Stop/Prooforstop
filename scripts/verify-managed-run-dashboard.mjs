// Prepared acceptance. Run only after the production dashboard adapter is built.
// Real managed submit/worker/heartbeat/sealed terminal; injected provider runner,
// not a claim of external provider or graphical browser acceptance.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
const repo=fs.realpathSync(process.argv[2] ?? process.cwd());
const dashboardModule=process.argv[3] ?? path.join(repo,'packages/main/dist/core/managed-run-dashboard.js');
const {readManagedRunDashboard}=await import(pathToFileURL(dashboardModule));
const {submitManagedHostRun,runManagedHostRunWorker,managedHostRunDirectory,getManagedHostRunStatus}=await import(pathToFileURL(path.join(repo,'packages/main/dist/core/managed-host-run.js')));
const root=fs.mkdtempSync(path.join(os.tmpdir(),'u13-dashboard-worker-'));
const sentinel='PRIVATE_PROMPT_OR_PROVIDER_TEXT_MUST_NOT_REACH_DASHBOARD';
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
function tree(directory){
 const entries=[];
 function walk(dir){for(const entry of fs.readdirSync(dir,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))){
  const file=path.join(dir,entry.name),relative=path.relative(directory,file),stat=fs.lstatSync(file);
  if(stat.isSymbolicLink())entries.push([relative,'link',fs.readlinkSync(file)]);
  else if(stat.isDirectory()){entries.push([relative,'directory']);walk(file);}
  else if(stat.isFile()) entries.push([relative,stat.mode,stat.size,hash(fs.readFileSync(file))]);
  else entries.push([relative,'special',stat.mode]);
 }}walk(directory);return hash(JSON.stringify(entries));
}
function readOnly(){const before=tree(root),result=readManagedRunDashboard(root);assert.equal(typeof result?.then,'undefined','Graph callback must be synchronous');assert.equal(tree(root),before,'dashboard must not create/recover/refresh any project artifact');assert.doesNotMatch(JSON.stringify(result),new RegExp(sentinel));
 for(const row of result.runs){assert.deepEqual(Object.keys(row).sort(),['runId','storyId','host','state','stage','queueReason','lastProviderProgressAt','durationEstimate','terminal'].sort());assert.equal('workerHeartbeatAt' in row,false);if(row.terminal)assert.equal(row.terminal.reason,row.terminal.state);}
 return result;}
const find=(dashboard,runId)=>dashboard.runs.find(row=>row.runId===runId);
let release,worker,emit;
const ready=new Promise(resolve=>{release=resolve;});
try{
 fs.writeFileSync(path.join(root,'unchanged-story.txt'),'same story subject');
 const unchanged=hash(fs.readFileSync(path.join(root,'unchanged-story.txt')));
 const result=await submitManagedHostRun({root,cwd:root,host:'codex',storyId:null,phase:'DEV',agentType:'dashboard-owned-fixture',reviewRunId:null,lane:null,promptText:sentinel,projectRootHash:'fixture',deadlineMs:15000,timeoutMs:10000,profile:null},{
  claimTimeoutMs:2000,claimPollMs:5,
  launchWorker:async request=>{worker=runManagedHostRunWorker(request,{heartbeatMs:20,cancelPollMs:10,env:{PROOF_OR_STOP_USAGE_LEDGER:'0'},runner:async plan=>{
   emit=()=>plan.onChunk?.({stream:'stdout',text:sentinel});emit();await ready;
   return {stdout:sentinel,stderr:sentinel,exitCode:0,timedOut:false,terminalReason:'completed',finalAssistantResult:sentinel,finalAssistantResultCount:1,finalAssistantResultTruncated:false};
  }});return {pid:process.pid};},
 });
 const first=find(readOnly(),result.runId);assert.ok(first,'retained active run is visible');
 assert.equal(first.terminal,null);
 const snapshotFile=path.join(managedHostRunDirectory(root,result.runId),'snapshot.json');const snapshotBytes=fs.readFileSync(snapshotFile);const invalidSnapshot=JSON.parse(snapshotBytes);invalidSnapshot.state='UNKNOWN_MALFORMED_STATE';fs.writeFileSync(snapshotFile,JSON.stringify(invalidSnapshot));assert.ok(!find(readOnly(),result.runId),'unknown states cannot appear as normal runs');fs.writeFileSync(snapshotFile,snapshotBytes);
 const firstHeartbeat=(await getManagedHostRunStatus({root,runId:result.runId})).run.workerHeartbeatAt;
 let heartbeat;
 const deadline=Date.now()+2000;
 do{await new Promise(resolve=>setTimeout(resolve,25));heartbeat=(await getManagedHostRunStatus({root,runId:result.runId})).run.workerHeartbeatAt;}while(heartbeat===firstHeartbeat&&Date.now()<deadline);
 assert.notEqual(heartbeat,firstHeartbeat,'actual worker heartbeat advances');
 assert.equal(find(readOnly(),result.runId).lastProviderProgressAt,first.lastProviderProgressAt,'heartbeat alone must not invent provider progress');
 emit();const advanced=find(readOnly(),result.runId);
 assert.notEqual(advanced.lastProviderProgressAt,first.lastProviderProgressAt,'unchanged Story hashes must not suppress real provider progress');
 assert.equal(hash(fs.readFileSync(path.join(root,'unchanged-story.txt'))),unchanged);
 release();const terminal=await worker;assert.equal(terminal.state,'completed');
 const done=find(readOnly(),result.runId);assert.equal(done.state,'completed');assert.match(done.terminal.digest,/^(sha256:)?[a-f0-9]{64}$/);
 assert.equal(find(readOnly(),result.runId).terminal.digest,done.terminal.digest,'repeat polling retains exact dedup identity');
 const file=path.join(managedHostRunDirectory(root,result.runId),'terminal.json');
 const original=fs.readFileSync(file),bad=JSON.parse(original);bad.resultDigest='sha256:'+('0'.repeat(64));fs.writeFileSync(file,JSON.stringify(bad));
 const broken=readOnly();assert.ok(!find(broken,result.runId)||find(broken,result.runId).state!=='completed');
 assert.ok(broken.diagnostics.includes('invalid_managed_run'),'invalid receipt must be visible without success');
 fs.writeFileSync(file,original);assert.equal(find(readOnly(),result.runId).terminal.digest,done.terminal.digest);

 const checkSpecial=()=>{
  const before=tree(root);
  const query=`import {readManagedRunDashboard} from ${JSON.stringify(pathToFileURL(dashboardModule).href)};console.log(JSON.stringify(readManagedRunDashboard(${JSON.stringify(root)})));`;
  const response=JSON.parse(execFileSync(process.execPath,['--input-type=module','-e',query],{encoding:'utf8',timeout:1500}));
  assert.equal(tree(root),before);assert.ok(response.diagnostics.includes('invalid_managed_run'));assert.ok(!find(response,result.runId));
 };
 fs.unlinkSync(file);execFileSync('mkfifo',[file]);checkSpecial();fs.unlinkSync(file);fs.writeFileSync(file,original);
 const linked=path.join(root,'external-terminal.json');fs.writeFileSync(linked,original);fs.unlinkSync(file);fs.symlinkSync(linked,file);checkSpecial();fs.unlinkSync(file);fs.writeFileSync(file,original);fs.unlinkSync(linked);
 const oversized=path.join(managedHostRunDirectory(root,result.runId),'result.json');const resultBytes=fs.readFileSync(oversized);fs.truncateSync(oversized,65*1024*1024);const limited=readManagedRunDashboard(root);assert.ok(limited.diagnostics.includes('managed_runtime_scan_limit'),'total byte budget refuses before large runtime reads');assert.ok(!find(limited,result.runId));fs.writeFileSync(oversized,resultBytes);assert.equal(find(readOnly(),result.runId).terminal.digest,done.terminal.digest,'observation budget is scoped and resets for the next call');
 console.log('U13_ACTUAL_WORKER_READONLY_HEARTBEAT_CORRUPT_TERMINAL_FIFO_SYMLINK_PASS');

}finally{release?.();await worker?.catch(()=>{});fs.rmSync(root,{recursive:true,force:true});}
