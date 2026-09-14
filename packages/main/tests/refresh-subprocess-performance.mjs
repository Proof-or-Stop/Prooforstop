import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,writeFileSync,readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';import {join} from 'node:path';import {spawnSync} from 'node:child_process';
const directory=mkdtempSync(join(tmpdir(),'refresh-subprocess-pair-'));
console.log('REFRESH_SUBPROCESS_OUTPUT '+JSON.stringify({directory}));
const started=performance.now();
const result=spawnSync(process.execPath,['packages/main/tests/scan-attribution-run.mjs',directory,'--refresh-single-scan','--refresh-subprocess'],{cwd:process.cwd(),encoding:'utf8',timeout:1250000,maxBuffer:96*1024*1024});
writeFileSync(join(directory,'harness.stdout.log'),result.stdout??'');writeFileSync(join(directory,'harness.stderr.log'),result.stderr??'');
process.stdout.write(result.stdout??'');process.stderr.write(result.stderr??'');
assert.equal(result.status,0,'Native fanout and prior refresh regression must pass');assert.equal(result.signal,null);assert.ok(!result.error);
const all=readdirSync(directory).filter(n=>n.endsWith('.jsonl')).flatMap(n=>readFileSync(join(directory,n),'utf8').split('\n').filter(Boolean).map(JSON.parse));
// The four-costs guarantees stay in force: no same-scan rereads and no second producer plan per batch row.
const scans=all.filter(r=>r.kind==='scan'),details=all.filter(r=>r.kind==='scanDetail');assert.ok(scans.length>0&&details.length>0);
const plans=scans.filter(r=>{const i=r.stack.findIndex(s=>s.includes('at verificationProducerPlan ('));return i>=0&&r.stack[i+1]?.includes('at enforceWithPublicationRecovery (');});
const fourCosts={duplicateBatchPlans:Math.max(0,plans.length-17),duplicateFileReads:details.reduce((s,r)=>s+r.duplicateReads,0)};console.log('FOUR_COSTS_DEFECTS '+JSON.stringify(fourCosts));
assert.deepEqual(fourCosts,{duplicateBatchPlans:0,duplicateFileReads:0},'FOUR_COSTS_REGRESSION: duplicate batch planning or repeated file reads returned');
const rows=all.filter(r=>r.kind==='refreshSubprocess');
const large=rows.filter(r=>r.rows>=71);
for(const label of ['coverage','groups','write'])assert.ok(large.some(r=>r.label===label),'Missing actual 71-row refresh scope: '+label);
const metric={directory,elapsedMs:performance.now()-started,scopes:large.map(r=>({label:r.label,rows:r.rows,calls:r.calls,ms:r.ms,top:Object.entries(r.commands).sort((a,b)=>b[1]-a[1]).slice(0,5)}))};
writeFileSync(join(directory,'refresh-subprocess.json'),JSON.stringify(metric,null,2)+'\n');console.log('REFRESH_SUBPROCESS_METRIC '+JSON.stringify(metric));
// One synchronous scope observes the current repository state once. Per-row
// receipt validation must not scale git subprocesses with the number of rows.
assert.ok(large.every(r=>r.calls<=16),'REFRESH_SUBPROCESS_RED: refresh scopes repeat current git state probes per row');
console.log('REFRESH_SUBPROCESS_GREEN');
