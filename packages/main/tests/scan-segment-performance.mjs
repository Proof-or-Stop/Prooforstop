import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,writeFileSync,readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';import {join} from 'node:path';import {spawnSync} from 'node:child_process';
const directory=mkdtempSync(join(tmpdir(),'scan-segment-pair-'));
console.log('SCAN_SEGMENT_OUTPUT '+JSON.stringify({directory}));
const started=performance.now();
const result=spawnSync(process.execPath,['packages/main/tests/scan-attribution-run.mjs',directory,'--refresh-single-scan','--refresh-subprocess'],{cwd:process.cwd(),encoding:'utf8',timeout:1250000,maxBuffer:96*1024*1024});
writeFileSync(join(directory,'harness.stdout.log'),result.stdout??'');writeFileSync(join(directory,'harness.stderr.log'),result.stderr??'');
process.stdout.write(result.stdout??'');process.stderr.write(result.stderr??'');
assert.equal(result.status,0,'Native fanout and prior refresh regression must pass');assert.equal(result.signal,null);assert.ok(!result.error);
const all=readdirSync(directory).filter(n=>n.endsWith('.jsonl')).flatMap(n=>readFileSync(join(directory,n),'utf8').split('\n').filter(Boolean).map(JSON.parse));
const scans=all.filter(r=>r.kind==='scan'),details=all.filter(r=>r.kind==='scanDetail');assert.ok(scans.length>0&&details.length>0);
// Prior guarantees: no same-scan rereads, and every producer entrypoint supplies the plan it computed inside its lock.
const recoveryPlans=scans.filter(r=>{const i=r.stack.findIndex(s=>s.includes('at verificationProducerPlan ('));return i>=0&&r.stack[i+1]?.includes('at enforceWithPublicationRecovery (');}).length;
const duplicateFileReads=details.reduce((s,r)=>s+r.duplicateReads,0);
const refresh=all.filter(r=>r.kind==='refreshSubprocess'&&r.rows>=71);
for(const label of ['coverage','groups','write'])assert.ok(refresh.some(r=>r.label===label),'Missing actual 71-row refresh scope: '+label);
const refreshOverBound=refresh.filter(r=>r.calls>16).length;
// New: one synchronous segment observes the implementation once. Scans inside an explicit
// synchronous observation scope share by design; a segment that still holds an unscoped
// scan next to any other scan repeats the same 54 MB read within one tick.
const scoped=r=>r.stack.some(s=>s.includes('at withVerificationPlanningObservation ('));
const segments=new Map();for(const r of scans){const key=r.pid+':'+r.epoch;if(!segments.has(key))segments.set(key,[]);segments.get(key).push(r);}
let duplicateSegmentScans=0,duplicateSegmentBytes=0;const owners={};
for(const group of segments.values()){if(group.length<2||group.every(scoped))continue;duplicateSegmentScans+=group.length-1;for(const r of group.slice(1))duplicateSegmentBytes+=r.bytes;
 const owner=group.map(r=>r.stack.filter(s=>!/executionImplementationIdentity|prepareVerificationExecutionIdentity|withExecutableDigestObservation|planningImplementationIdentityDigest|node:internal|profile\.mjs|verification-execution-evidence\.js/.test(s)).slice(0,1).map(s=>s.replace(/\s*\(.*\)/,'').replace(/^\s*at\s+/,'')).join('')).join(' + ');owners[owner]=(owners[owner]??0)+1;}
const metric={directory,elapsedMs:performance.now()-started,scans:scans.length,segments:segments.size,duplicateSegmentScans,duplicateSegmentBytes,recoveryPlans,duplicateFileReads,refreshOverBound,owners};
writeFileSync(join(directory,'scan-segment.json'),JSON.stringify(metric,null,2)+'\n');console.log('SCAN_SEGMENT_METRIC '+JSON.stringify(metric));
assert.deepEqual({duplicateSegmentScans,recoveryPlans,duplicateFileReads,refreshOverBound},{duplicateSegmentScans:0,recoveryPlans:0,duplicateFileReads:0,refreshOverBound:0},'SCAN_SEGMENT_RED: one synchronous segment scans the implementation more than once');
console.log('SCAN_SEGMENT_GREEN');
