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
