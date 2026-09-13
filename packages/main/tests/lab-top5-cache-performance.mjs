import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import path from 'node:path';
import {mkdtempSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {verifyBuildBinding,verifyUtilsBuildBinding} from '../../../scripts/full-suite-build-binding.mjs';
import {prepareBenchmarkCheckout} from './lab-benchmark-checkout.mjs';
const sourceRoot=process.cwd(),suite=Number(process.argv[2]);
const root=suite===2?await prepareBenchmarkCheckout(sourceRoot):sourceRoot;
const commands={
  2:['scripts/run-validation-fixture-suite.mjs','packages/main/dist/tasks/quorum-submit-smoke.js','--jobs=2'],
  3:['packages/main/dist/tasks/finding-identity-lineage-smoke.js','--section=delivery'],
  5:['scripts/run-validation-fixture-suite.mjs','packages/main/dist/tasks/validate-progress-heartbeat-smoke.js'],
};
const markers={2:/quorum_submit smoke passed \(73 checks\)/,3:/FINDING_IDENTITY_DELIVERY PASS 93 passing 0 failed/,5:/validate-progress-heartbeat smoke passed/};
assert.ok(commands[suite]);
verifyBuildBinding(root);verifyUtilsBuildBinding(root);
const start=performance.now(),native=spawnSync(process.execPath,commands[suite],{cwd:root,encoding:'utf8',timeout:1200000,maxBuffer:96*1024*1024});
const wallMs=performance.now()-start;
const outputRoot=mkdtempSync(path.join(tmpdir(),'top5-native-output-'));
writeFileSync(path.join(outputRoot,'stdout.log'),native.stdout??'');writeFileSync(path.join(outputRoot,'stderr.log'),native.stderr??'');
console.log('TOP5_NATIVE_OUTPUT '+JSON.stringify({outputRoot}));
console.log('TOP5_PROFILE '+JSON.stringify({suite,command:['node',...commands[suite]],wallMs,nativeExitCode:native.status,nativeSignal:native.signal,formalStoryEvidence:false}));
if(suite===2) {
 const raw=native.stdout.split('\n').filter(line=>line.startsWith('QUORUM_SMOKE_RUN_JSON ')).map(line=>JSON.parse(line.slice('QUORUM_SMOKE_RUN_JSON '.length)));
 const report=raw.find(row=>row.coordinator==='default-parent');
 if(report) console.log('TOP5_QUORUM_REPORT '+JSON.stringify({ok:report.ok,results:report.results.map(row=>({caseId:row.caseId,status:row.status,startedAtMs:row.startedAtMs,endedAtMs:row.endedAtMs})),shards:report.shards,processTreeReaped:report.processTreeReaped,residue:report.residue,protectedMutationGuard:{clean:report.protectedMutationGuard.clean,eventCount:report.protectedMutationGuard.eventCount}}));
 process.stdout.write(native.stdout.split('\n').filter(line=>!line.startsWith('QUORUM_SMOKE_RUN_JSON ')).join('\n'));
} else process.stdout.write(native.stdout??'');
process.stderr.write((native.stderr??'').slice(-16000));
assert.equal(native.status,0,'Full native suite must pass before asserting performance');assert.match(native.stdout,markers[suite]);
if(suite===2) {
 const reports=native.stdout.split('\n').filter(line=>line.startsWith('QUORUM_SMOKE_RUN_JSON ')).map(line=>JSON.parse(line.slice('QUORUM_SMOKE_RUN_JSON '.length)));
 const report=reports.find(row=>row.coordinator==='default-parent'&&row.results?.length===73);assert.ok(report,'complete parent report required');
 assert.equal(report.ok,true);assert.equal(report.processTreeReaped,true);assert.deepEqual(report.residue,{temp:0,process:0,ticket:0,quarantine:0});
 assert.equal(new Set(report.results.map(row=>row.caseId??row.id)).size,73);
}
const line=native.stdout.split('\n').find(line=>line.startsWith('FIXTURE_COMPILE_CACHE '));assert.ok(line,'cache observation must exist');
const cache=JSON.parse(line.slice('FIXTURE_COMPILE_CACHE '.length));
assert.ok(cache.files>0&&cache.bytes>0,`TOP5_${suite}_RED: repeated native children have no disposable compilation cache`);
console.log(`TOP5_${suite}_GREEN`);
