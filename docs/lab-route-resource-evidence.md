# Route resource registration evidence packet (review draft)

Scope: restore canonical inventory admission for an already registered native route command. This packet reports observations, not a universal throughput or timeout guarantee. No whole-suite PASS is claimed.

## Reviewed-input delivery

scripts/lab-audit.mjs auditInput snapshots only changed tracked blobs. There is no extra dependency/input CLI flag in that mechanism. The supported way to make this packet reviewable is to commit it as a bounded documentation artifact after owner review. No changes to audit policy, read restrictions or prior audit records are proposed. The exact unchanged verifier below is copied from the named immutable blob; its contents remain untrusted source for audit.

## Exact production verifier

Commit: 86a13b239ec0982c04b66773bee0a08db3d15252. Path: scripts/verify-route-reattestation-dependency-direction.mjs. Git blob: 424ff927b29d0dedc38c5d860f63099afb656b60

```javascript
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
const root=process.cwd(),require=createRequire(resolve(root,'package.json')),ts=require('typescript');
const contract=readFileSync(resolve(root,'scripts/verify-process-fact-contract.mjs'),'utf8');
const source=readFileSync(resolve(root,'packages/main/src/handlers/finding-route.ts'),'utf8');
const parsed=ts.createSourceFile('contract.mjs',contract,ts.ScriptTarget.Latest,true);
const existing=parsed.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='story2DependencyIssues');assert(existing,'SETUP original actual dependency checker unavailable');
const oldCheck=new Function('ts',existing.getText(parsed)+';return story2DependencyIssues;')(ts);
const imports=[];function visit(n){const s=(ts.isImportDeclaration(n)||ts.isExportDeclaration(n))?n.moduleSpecifier:ts.isCallExpression(n)&&n.expression.kind===ts.SyntaxKind.ImportKeyword?n.arguments[0]:undefined;if(s&&ts.isStringLiteral(s)&&s.text.includes('finding-material-reattestation'))imports.push(s.text);ts.forEachChild(n,visit);}visit(ts.createSourceFile('route.ts',source,ts.ScriptTarget.Latest,true));
console.log('ROUTE_DIRECTION_ACTUAL_OBSERVATION '+JSON.stringify({actualReverseImports:imports,existingCheckerIssues:oldCheck(source)}));
assert.deepEqual(imports,[],'ROUTE_DIRECTION_REQUIRED Story2 route must not import Story1 material re-attestation');
const dag=parsed.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='findingDagDependencyIssues');assert(dag,'ROUTE_DIRECTION_REQUIRED actual contract needs canonical owner-aware DAG guard');
const check=new Function('ts',dag.getText(parsed)+';return findingDagDependencyIssues;')(ts);
assert.deepEqual(check(source,'Story2'),[]);
for(const injection of ["import {x} from './finding-material-reattestation.js';","export {x} from './finding-material-reattestation.js';","await import('./finding-material-reattestation.js');"]){
 const expected='FINDING_DAG_FORBIDDEN: Story2->Story1: ./finding-material-reattestation.js';
 assert(check(source+'\n'+injection,'Story2').includes(expected),'ROUTE_DIRECTION_REQUIRED exact real checker must reject reverse import');
}
console.log('ROUTE_DIRECTION_GREEN actual source clean and canonical reverse-edge mutations rejected');

const {execFileSync}=await import('node:child_process');
for (const flags of [[], ['--head-continuity']]) {
 const output=execFileSync(process.execPath,['packages/main/dist/tasks/finding-material-reattestation-smoke.js','--route-restoration-port',...flags], {cwd:root,encoding:'utf8',stdio:'pipe',timeout:120000});
 process.stdout.write(output);
 assert(output.includes('ROUTE_RESTORATION_PORT PASS'), 'ROUTE_DIRECTION_REQUIRED native restoration port controls executed');
}
// Unchanged main0.3.331 history PASS82 measured237.373s; retain the complete
// workload under the existing documented300s lineage budget, with hard timeout.
const historyOutput=execFileSync(process.execPath,['packages/main/dist/tasks/finding-identity-lineage-smoke.js','--section=history'],{cwd:root,encoding:'utf8',stdio:'pipe',timeout:300000,killSignal:'SIGKILL'});
process.stdout.write(historyOutput);
assert(historyOutput.includes('FINDING_IDENTITY_ROUTES PASS') && historyOutput.includes('FINDING_IDENTITY_HISTORY PASS'), 'ROUTE_DIRECTION_REQUIRED original route/progress/history regressions execute');
const contractOutput=execFileSync(process.execPath,['scripts/verify-process-fact-contract.mjs','--quiet'],{cwd:root,encoding:'utf8',stdio:'pipe',timeout:120000});
process.stdout.write(contractOutput);
console.log('ROUTE_DIRECTION_NATIVE_GREEN signed material and head-only restoration preserved');
```

## Actual observations

Historical main0.3.331 (8153a0c5920a50a5709425385769e4cdbc99a614) ran the complete unchanged history selector with82 assertions in237.372695542s, exit0. Command: node packages/main/dist/tasks/finding-identity-lineage-smoke.js --section=history. UTC02:24:43.804981 to02:28:41.172761 on2026-09-12. The300s deadline leaves62.627s, or26.38% above this observation. This was a serialized baseline, not a concurrency guarantee.

The initial120s wrapper timed out on this same full workload; the owned child continued under the earlier SIGTERM handling and was explicitly stopped. That wrapper failure was not recorded as product RED. The corrected wrapper retained all82 assertions under the repository-documented300s lineage budget and SIGKILL. No receipt TTL or product guard was relaxed.

Official successful replay records (elapsed covers the complete sequential verifier, not history alone):
```json
[
  {
    "kind": "green",
    "head": "e669ed2d4d8e93b49cf70f11fb81699d2c00072f",
    "status": 0,
    "signal": null,
    "elapsedMs": 349030,
    "at": "2026-09-12T02:35:16.735Z",
    "timeoutMs": 900000
  },
  {
    "kind": "synced-green",
    "head": "e669ed2d4d8e93b49cf70f11fb81699d2c00072f",
    "status": 0,
    "signal": null,
    "elapsedMs": 352125,
    "at": "2026-09-12T02:42:28.619Z",
    "timeoutMs": 900000
  },
  {
    "kind": "candidate-green",
    "head": "86a13b239ec0982c04b66773bee0a08db3d15252",
    "status": 0,
    "signal": null,
    "elapsedMs": 355392,
    "at": "2026-09-12T02:48:36.265Z",
    "timeoutMs": 900000
  },
  {
    "kind": "main-green",
    "head": "86a13b239ec0982c04b66773bee0a08db3d15252",
    "status": 0,
    "signal": null,
    "elapsedMs": 348007,
    "at": "2026-09-12T03:02:12.235Z",
    "timeoutMs": 900000
  }
]
```

The first green was serialized. The subsequent official finish was explicitly scheduled as contended with at most two local jobs on distinct immutable checkouts. Its wrapper ran02:36:35.515055 to03:02:17.474514 (1541.94823s, including audit/builds). The scheduling record is not a continuous CPU-load trace. These successful contended replays demonstrate that the existing child deadline was met in those runs; they do not establish worst-case jobs2/4 behavior. Individual history-child elapsed times were not instrumented during those replays. Do not substitute full-verifier duration for child duration.

Complete raw logs retained with SHA256:

- /tmp/B-e6d9-route-direction-main-history-baseline.log: `6631a7c3a040505461f38c37c7b604beb40b4fbbb7a2aa2e253fbf3203ea30c2` (7679 bytes).
- /tmp/B-e6d9-route-direction-official-green2.log: `43793cdcb2d803de44cf0f53fc7f9e4505c900a033a7ddfd3fa5025e2ad54b46` (14078 bytes).
- /tmp/B-e6d9-route-direction-official-finish.log: `2c8f0a06777e7cfe68d41cd8f479d0bdcf70798fdda94715c5e956e24194c730` (42358 bytes).

## Resource graph and timeout limits

The verifier invokes each material fixture, then history, then the contract via execFileSync: no overlap among those four stages. Native fixtures create disposable Git roots. History has an intentional two-child public recall race; resource correctness does not imply unlimited CPU capacity. Its repoRead claim is git-common-dir key dot, shared; tempOwnership is runner-owned-unique. There is no claimed shared mutable fixture path or fixed port. The new entry adds no heavy exclusive edge to existing flow/rollout/intent chains.

Current host read-only observation: `{"availableParallelism":15,"defaultJobs":3}`. defaultJobs derives max1/min(hostCap,floor(cpuCount/4)), with hostCap2 up to12 logical CPUs, otherwise4. At jobs>1 the outer600000ms becomes900000ms under1.5 headroom;1200000ms suite ceiling remains unchanged. Inner history300000ms is independent and not scaled by that policy.

Open limitation: no current full canonical71-member timing run has been performed by this bounded repair. Existing comments report an older49-member832.8s run; it must not be presented as a current suite result. Potential contention is a risk requiring measurement if observed, not a reproduced timeout in these completed runs. Neither extra machine-wide serialization nor a global budget increase follows from these observations alone.

## Audit outcomes preserved

First resource audit: fail241.259s, proposed exclusive-heavy placement created a long serialized-chain risk. Removed that placement. Second resource audit: fail242.329s, accepted membership repair but raised possible inner-timeout contention and unmeasured full-suite duration. Both candidates stopped before main integration. No approval is claimed by this packet.

## Follow-up three-replica contention observation (2026-09-12)

This follow-up is three independent invocations of the same unchanged native route verifier, not three different canonical members and not a full-suite result. The production scheduler ran at jobs=3, using clones of the actual route entry's shared-read resource claims, scaled outer budget and runner-owned private temporary roots. Scratch aliases distinguished load replicas; they did not register new canonical tests. The coordinator drained all other controlled heavy jobs before granting the exclusive measurement window. This is a coordination record, not a claim that every unrelated OS process was absent.

Official sync completed in0.720s, then the isolated build passed in12.892s. The workload wrapper ran03:45:19.008370 to03:52:23.807972 UTC,424.795872542s, exit0. Queue waiting is excluded. Tested HEAD: `22f4b0edeb58768c91bc54727fecc69ccc7ea10e`.

The observer was loaded only into each verifier parent through `node --import`; it recorded monotonic elapsed time around the original `execFileSync` call and delegated the exact original arguments and options. It did not set NODE_OPTIONS or alter native child argv/environment, signed authority, receipt TTLs, source files, deadlines or return values. Every history call retained `timeout:300000, killSignal:'SIGKILL'`. The observed history margin is narrow: the slowest used292.967172167s, leaving7.032827833s (2.34% of its300s allowance). This run does not establish a universal timeout or throughput guarantee and did not reproduce an actual timeout. No budget adjustment is made from it.

All three histories overlapped from03:47:19.850 to03:52:05.147 UTC, exactly285.297s. All completed with exit0 and the original `FINDING_IDENTITY_HISTORY PASS 82 passing 0 failed cases` marker. The maximum sampled one-minute load average was16.2119140625; this is host telemetry, not a causal attribution to these workers alone.

Per-parent stage elapsed seconds (all status0, no signal):

| Parent PID | Material restoration | Head continuity | History | Process contract |
|---|---:|---:|---:|---:|
| 9071 | 51.337634916 | 68.794639458 | 292.967172167 | 10.982681750 |
| 9072 | 51.345905250 | 68.807332584 | 292.951687917 | 10.972845625 |
| 9073 | 50.005294750 | 67.014522875 | 288.429180209 | 10.779804917 |

Exact history intervals and final results:

```json
{
  "head": "22f4b0edeb58768c91bc54727fecc69ccc7ea10e",
  "histories": [
    {
      "event": "end",
      "utc": "2026-09-12T03:52:05.147Z",
      "pid": 9073,
      "args": [
        "packages/main/dist/tasks/finding-identity-lineage-smoke.js",
        "--section=history"
      ],
      "startUtc": "2026-09-12T03:47:16.716Z",
      "elapsedMs": 288429.180209,
      "status": 0,
      "signal": null,
      "remainingMs": 11570.819790999987
    },
    {
      "event": "end",
      "utc": "2026-09-12T03:52:12.802Z",
      "pid": 9071,
      "args": [
        "packages/main/dist/tasks/finding-identity-lineage-smoke.js",
        "--section=history"
      ],
      "startUtc": "2026-09-12T03:47:19.833Z",
      "elapsedMs": 292967.172167,
      "status": 0,
      "signal": null,
      "remainingMs": 7032.8278329999885
    },
    {
      "event": "end",
      "utc": "2026-09-12T03:52:12.804Z",
      "pid": 9072,
      "args": [
        "packages/main/dist/tasks/finding-identity-lineage-smoke.js",
        "--section=history"
      ],
      "startUtc": "2026-09-12T03:47:19.850Z",
      "elapsedMs": 292951.68791700003,
      "status": 0,
      "signal": null,
      "remainingMs": 7048.312082999968
    }
  ],
  "allThreeHistoryOverlapSeconds": 285.297,
  "entryResults": [
    {
      "name": "test:route-reattestation-dependency-direction",
      "status": "PASS",
      "durationMs": 424555.71187500004
    },
    {
      "name": "test:route-reattestation-dependency-direction:load-1",
      "status": "PASS",
      "durationMs": 416693.87079099996
    },
    {
      "name": "test:route-reattestation-dependency-direction:load-2",
      "status": "PASS",
      "durationMs": 424539.221958
    }
  ],
  "tempRootsRemaining": [],
  "peakOneMinuteLoad": 16.2119140625,
  "history82Markers": [
    {
      "name": "test:route-reattestation-dependency-direction",
      "present": true
    },
    {
      "name": "test:route-reattestation-dependency-direction:load-1",
      "present": true
    },
    {
      "name": "test:route-reattestation-dependency-direction:load-2",
      "present": true
    }
  ],
  "stagesSha256": "fd5228ee754c8b5d801c62d2a3b6a266e69d7df01d5d966eae3db01c5220bbb0"
}
```

Cleanup: the production runner removed all three owned temporary roots, and an exact probe-process scan found no remaining owned workers. The measured heavy-work slot was released immediately after collection. No source/dist edits occurred during the run.

The earlier mixed three-member attempt remains separate: brief-output passed33.120s, while flow-stability failed44.489s because its acceptance-basis assertion expected complete but observed partial. Production fail-fast interrupted route during the first material stage, before any history timing. That attempt did not measure the target timeout and is not route RED. Its results remain at `/tmp/B-e6d9-route-contention-attempt1`; no unrelated flow repair is part of this Lab.

Raw observation files retained (SHA256):

- `/tmp/B-e6d9-route-contention-v2-stages.jsonl`: `fd5228ee754c8b5d801c62d2a3b6a266e69d7df01d5d966eae3db01c5220bbb0`.
- `/tmp/B-e6d9-route-contention-v2-results.json`: `98373bc5312f0bc5f9a7376a944f535a178143788e8b4bb2a11780b4f806e2dc`.
- `/tmp/B-e6d9-resource-stress-three-replicas.log`: `a135f74cfeac6ee1fa04b98e92e155765ec22423a26f760e85a77037b6516eac`.

Reproducible observational harness used for this measurement (scratch only, no production instrumentation):

### B-e6d9-route-contention-v2.mjs

```javascript
import {readFileSync,writeFileSync,appendFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {performance} from 'node:perf_hooks';
import {loadavg,availableParallelism} from 'node:os';
import {execFileSync} from 'node:child_process';
const cwd=process.cwd();
const r=await import(pathToFileURL(resolve('packages/main/dist/tasks/full-suite-runner.js')));
const target='test:route-reattestation-dependency-direction';
const names=[target,target+':load-1',target+':load-2'];
const entries=r.canonicalizeEntries(names.map(name=>{const row=r.FULL_SUITE_ENTRIES.find(e=>e.name===target);if(!row)throw new Error('missing actual resource row '+name);return {...row,name};}),cwd);
const state=r.createFullSuiteRunState();
for(const sig of ['SIGINT','SIGTERM'])process.once(sig,()=>r.interruptFullSuiteRun(sig,state));
const stages='/tmp/B-e6d9-route-contention-v2-stages.jsonl';
writeFileSync(stages,'');
const started=performance.now();
const emit=row=>appendFileSync(stages,JSON.stringify({...row,utc:new Date().toISOString(),elapsedMs:performance.now()-started})+'\n');
emit({event:'profile',jobs:3,defaultJobs:r.defaultJobs(),availableParallelism:availableParallelism(),head:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),entries});
const sample=setInterval(()=>emit({event:'load',loadavg:loadavg(),activeTopLevelChildren:state.activeChildren.size}),1000);
try{
 const results=await r.runScheduled(entries,3,async entry=>{
  emit({event:'entry-start',name:entry.name});
  const result=await r.runEntry(r.withConcurrencyHeadroom(entry,3),cwd,'/tmp/B-e6d9-route-contention-v2-npm.mjs',()=>emit({event:'spawn',name:entry.name}),state);
  writeFileSync('/tmp/B-e6d9-route-contention-v2-'+entry.name.replaceAll(':','-')+'.log',result.output);
  emit({event:'entry-end',name:entry.name,status:result.status,durationMs:result.durationMs,reason:result.reason??null});
  return result;
 },r.fullSuiteSchedulerOptions(state));
 writeFileSync('/tmp/B-e6d9-route-contention-v2-results.json',JSON.stringify({profile:'three replicas of actual native route workload using canonical resource claims; not distinct canonical members or full suite',jobs:3,elapsedMs:performance.now()-started,results},null,2));
 console.log(JSON.stringify(results.map(({name,status,durationMs,reason})=>({name,status,durationMs,reason}))));
 process.exitCode=results.every(v=>v.status==='PASS')?0:1;
}finally{clearInterval(sample);}
```

### B-e6d9-route-contention-v2-observer.mjs

```javascript
import cp from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {appendFileSync} from 'node:fs';
import {performance} from 'node:perf_hooks';
const original=cp.execFileSync;
const target='/tmp/B-e6d9-route-contention-v2-stages.jsonl';
if(process.argv[1]?.endsWith('/scripts/verify-route-reattestation-dependency-direction.mjs')) {
 cp.execFileSync=function(file,args,options) {
  const tracked=Array.isArray(args) && args.some(a=>/finding-material-reattestation-smoke|finding-identity-lineage-smoke|verify-process-fact-contract/.test(a));
  if(!tracked)return Reflect.apply(original,this,arguments);
  const start=performance.now(),utc=new Date().toISOString();let outcome={status:0,signal:null};
  appendFileSync(target,JSON.stringify({event:'start',utc,pid:process.pid,args,timeoutMs:options?.timeout,killSignal:options?.killSignal??'SIGTERM'})+'\n');
  try{return Reflect.apply(original,this,arguments);}catch(error){outcome={status:error.status??null,signal:error.signal??null,code:error.code??null};throw error;}
  finally{appendFileSync(target,JSON.stringify({event:'end',utc:new Date().toISOString(),pid:process.pid,args,startUtc:utc,elapsedMs:performance.now()-start,...outcome})+'\n');}
 };
 syncBuiltinESMExports();
}
```

### B-e6d9-route-contention-v2-npm.mjs

```javascript
#!/usr/bin/env node
import {spawnSync} from 'node:child_process';
import {resolve} from 'node:path';
const args=process.argv.slice(2);
const route=args.length===2&&args[0]==='run'&&['test:route-reattestation-dependency-direction','test:route-reattestation-dependency-direction:load-1','test:route-reattestation-dependency-direction:load-2'].includes(args[1]);
const result=spawnSync(route?process.execPath:'npm',route?['--import','/tmp/B-e6d9-route-contention-v2-observer.mjs',resolve('scripts/verify-route-reattestation-dependency-direction.mjs')]:args,{stdio:'inherit',env:process.env});
if(result.error)throw result.error;
if(result.signal)process.kill(process.pid,result.signal);
process.exitCode=result.status??1;
```
