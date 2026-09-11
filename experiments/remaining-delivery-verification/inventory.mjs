#!/usr/bin/env node
// Read-only planning inventory. This does not execute validation or attest adoption.
import {readFileSync,existsSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const git=(...args)=>execFileSync('git',args,{cwd:root,encoding:'utf8'}).trim();
const read=p=>readFileSync(resolve(root,p),'utf8');
const hash=x=>createHash('sha256').update(x).digest('hex');
const config=JSON.parse(read('proof-or-stop.config.json'));
const routine=config.validate.commands,done=config.doneRequiredCommands;
function inventory(rows,consumer){return rows.map((r,index)=>({consumer,index,command:r.command,args:r.args||[],timeoutMs:r.timeoutMs??null,resources:r.resources??null,executionReuse:r.executionReuse??null,executionInputs:r.executionInputs??null,assurance:r.assurance??null,riskTier:r.riskTier??null,closurePolicy:r.closurePolicy??null,fullBaselineReusePolicy:r.fullBaselineReusePolicy??null,providesBuildProof:r.providesBuildProof??null,requiresBuildProof:r.requiresBuildProof??null}));}
const commands=[...inventory(routine,'routine'),...inventory(done,'done')];
const groups=new Map();
for(const r of commands){const k=JSON.stringify([r.command,r.args]);groups.set(k,[...(groups.get(k)||[]),{consumer:r.consumer,index:r.index,timeoutMs:r.timeoutMs}]);}
const sources=[
 'scripts/lab-worktree.mjs','docs/lab-maintenance.md','docs/validation-performance.md',
 'packages/main/src/core/shared-validation-execution.ts','packages/main/src/core/causal-evidence.ts',
 'packages/main/src/core/validation-executor.ts','packages/main/src/core/process-metrics.ts',
 'scripts/real-story-replay-benchmark.mjs','scripts/run-dynamic-validation-replay.mjs',
 'packages/main/src/core/execution-implementation.ts','packages/main/src/cli-engine.ts',
 'docs/requirements/decisions/story-aware-dynamic-validation-execution-plan.md',
 'docs/requirements/decisions/codex-session-performance-and-workflow-optimization-plan.md'
];
const tests=[
 'experiments/five-item-closure/complete-closure-entry.mjs','experiments/five-item-closure/observe-reuse.mjs',
 'experiments/five-item-proof/identity.mjs','experiments/five-item-proof/identity-single-scan.mjs',
 'experiments/five-item-proof/output-retention-contract.mjs','experiments/five-item-proof/publication-restart.mjs',
 'experiments/five-item-proof/checkpoint-owner-recovery.mjs','experiments/five-item-proof/build-order.mjs',
 'scripts/verify-performance-production.mjs','scripts/run-dynamic-validation-replay.mjs'
];
const defaultJobs=Number(read('packages/main/src/core/validation-executor.ts').match(/export const DEFAULT_VALIDATE_PLAN_JOBS = (\d+);/)[1]);
const bound=read('packages/main/src/core/causal-evidence.ts').match(/export const CAUSAL_SELECTOR_OUTPUT_BOUND_BYTES = (\d+) \* (\d+);/);
const summary=rows=>({commands:rows.length,resourceDeclarations:rows.filter(r=>Array.isArray(r.resources)&&r.resources.length).length,exactInputsDeclarations:rows.filter(r=>r.executionReuse==='exact-inputs').length});
console.log(JSON.stringify({schema:'lab.remaining-delivery.planning-inventory.v1',kind:'read-only-source-and-config-observation',observedAt:new Date().toISOString(),root,head:git('rev-parse','HEAD'),mainHeadAtObservation:git('rev-parse','main'),branch:git('branch','--show-current'),packageVersion:JSON.parse(read('package.json')).version,configSha256:hash(read('proof-or-stop.config.json')),collectorSha256:hash(read('experiments/remaining-delivery-verification/inventory.mjs')),runtimePreparation:{labNodeModulesPresent:existsSync(resolve(root,'node_modules')),labMainDistPresent:existsSync(resolve(root,'packages/main/dist')),preparedCliIdentityMeasured:false},summary:{routine:summary(routine),done:summary(done),dynamicMode:config.validate.dynamic.mode,sharedExecution:config.validate.sharedExecution,reuseFreshRoutinePass:config.validate.reuseFreshRoutinePass,sourceDefaultOuterJobs:defaultJobs,sourceCompleteOutputBoundBytes:Number(bound[1])*Number(bound[2])},duplicateExecutableArgvCandidates:[...groups].filter(([,r])=>r.length>1).map(([key,consumers])=>({executableArgv:JSON.parse(key),consumers})),limitations:['Declarations are not evaluated runtime reuse eligibility.','Executable/argv equality is not complete execution identity or permission to reuse build proof.','No command timing, actual process adoption, full-suite PASS or RED/GREEN outcome was measured.','A source constant is not an observation of an invocation override.'],commands,sources:sources.map(path=>({path,sha256:hash(read(path))})),existingVerificationEntrypoints:tests.map(path=>({path,present:existsSync(resolve(root,path)),executed:false}))},null,2));
