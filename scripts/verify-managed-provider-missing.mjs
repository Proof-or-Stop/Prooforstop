import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getManagedHostRunStatus, managedHostRunDirectory } from '../packages/main/dist/core/managed-host-run.js';

const root=mkdtempSync(join(tmpdir(),'managed-provider-missing-'));
const cli=fileURLToPath(new URL('../packages/main/dist/cli.js',import.meta.url));
const marker=join(root,'provider.json');
let workerPid, directory;
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
try {
  const bin=join(root,'bin'); mkdirSync(bin);
  writeFileSync(join(bin,'codex'),`#!${process.execPath}
import {writeFileSync} from 'node:fs';
writeFileSync(${JSON.stringify(marker)},JSON.stringify({pid:process.pid,workerPid:process.ppid}));
process.stdin.resume(); setInterval(()=>{},1000);
`,{mode:0o700});
  const submitted=spawnSync(process.execPath,[cli,'--root',root,'host_run',JSON.stringify({host:'codex',
    phase:'DEV',agentType:'missing-provider-witness',prompt:'Observe missing provider independently.',
    detach:true,json:true,timeoutMs:90000,deadlineMs:90000})],
    {encoding:'utf8',timeout:15000,env:{PATH:`${bin}:${process.env.PATH}`,PROOF_OR_STOP_USAGE_LEDGER:'0'}});
  assert.equal(submitted.status,0,submitted.stderr);
  const run=JSON.parse(submitted.stdout).run;
  directory=managedHostRunDirectory(root,run.runId);
  const started=Date.now();
  while(!existsSync(marker)&&Date.now()-started<5000) await delay(25);
  const provider=JSON.parse(readFileSync(marker,'utf8'));
  const before=JSON.parse(readFileSync(join(directory,'snapshot.json'),'utf8'));
  assert.equal(provider.pid,before.providerIdentity.pid);
  assert.equal(provider.workerPid,before.workerPid);
  workerPid=provider.workerPid;
  process.kill(workerPid,'SIGSTOP');
  process.kill(provider.pid,'SIGKILL');
  const missingAt=Date.now();
  let snapshot;
  do {
    snapshot=JSON.parse(readFileSync(join(directory,'snapshot.json'),'utf8'));
    if(snapshot.supervisionDiagnostic?.code==='provider_missing') break;
    await delay(100);
  } while(Date.now()-missingAt<15000);
  assert.equal(snapshot.supervisionDiagnostic?.code,'provider_missing',
    'U02: live worker with a missing provider must publish an actionable diagnostic without status polling');
  assert.match(snapshot.supervisionDiagnostic.action,/inspect|recover/i);
  assert.equal(snapshot.state,'running','missing identity alone must not fabricate terminal authority');
  assert.equal(snapshot.lastProviderProgressAt,before.lastProviderProgressAt,
    'supervisor liveness diagnostics must not invent provider progress');
  const status=await getManagedHostRunStatus({root,runId:run.runId,afterGeneration:before.generation});
  assert.equal(status.changed,true,'the diagnostic is a semantic state change that wakes the owner');
  assert.equal(status.run.supervisionDiagnostic.code,'provider_missing');
  console.log('PASS U02 missing real provider with stopped live worker wakes via autonomous actionable diagnostic');
} finally {
  if(workerPid) {
    try { process.kill(workerPid,'SIGCONT'); } catch(error) { if(error.code!=='ESRCH') throw error; }
    const until=Date.now()+7000;
    while(directory&&!existsSync(join(directory,'terminal.json'))&&Date.now()<until) await delay(50);
  }
  rmSync(root,{recursive:true,force:true});
}
