import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,writeFileSync,readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';import {join} from 'node:path';import {spawnSync} from 'node:child_process';
const directory=mkdtempSync(join(tmpdir(),'git-segment-pair-'));
console.log('GIT_SEGMENT_OUTPUT '+JSON.stringify({directory}));
const started=performance.now();
const result=spawnSync(process.execPath,['packages/main/tests/scan-attribution-run.mjs',directory,'--refresh-single-scan','--git-segment'],{cwd:process.cwd(),encoding:'utf8',timeout:1250000,maxBuffer:96*1024*1024});
writeFileSync(join(directory,'harness.stdout.log'),result.stdout??'');writeFileSync(join(directory,'harness.stderr.log'),result.stderr??'');
process.stdout.write(result.stdout??'');process.stderr.write(result.stderr??'');
assert.equal(result.status,0,'Native fanout and prior refresh regression must pass');assert.equal(result.signal,null);assert.ok(!result.error);
const all=readdirSync(directory).filter(n=>n.endsWith('.jsonl')).flatMap(n=>readFileSync(join(directory,n),'utf8').split('\n').filter(Boolean).map(JSON.parse));
// Earlier guarantees stay in force.
const scans=all.filter(r=>r.kind==='scan'),details=all.filter(r=>r.kind==='scanDetail');assert.ok(scans.length>0&&details.length>0);
const recoveryPlans=scans.filter(r=>{const i=r.stack.findIndex(s=>s.includes('at verificationProducerPlan ('));return i>=0&&r.stack[i+1]?.includes('at enforceWithPublicationRecovery (');}).length;
const duplicateFileReads=details.reduce((s,r)=>s+r.duplicateReads,0);
const refresh=all.filter(r=>r.kind==='refreshSubprocess'&&r.rows>=71);for(const label of ['coverage','groups','write'])assert.ok(refresh.some(r=>r.label===label),'Missing actual 71-row refresh scope: '+label);
const refreshOverBound=refresh.filter(r=>r.calls>16).length;
const scoped=r=>r.stack.some(s=>s.includes('at withVerificationPlanningObservation ('));
const scanSegments=new Map();for(const r of scans){const key=r.pid+':'+r.epoch;if(!scanSegments.has(key))scanSegments.set(key,[]);scanSegments.get(key).push(r);}
let duplicateSegmentScans=0;for(const group of scanSegments.values()){if(group.length>=2&&!group.every(scoped))duplicateSegmentScans+=group.length-1;}
// New: one synchronous segment probes each git state once. Identical read-only git
// commands (same argv and cwd) never repeat inside one git observation, and never
// repeat among unscoped probes within one tick. Probes a consumer issues by calling
// public verification APIs in its own loop (here the smoke harness validating every
// receipt) belong to the consumer's observation, so only handler-owned probes count.
const probes=all.filter(r=>r.kind==='gitProbe');const product=probes.filter(r=>r.handlerOwned);assert.ok(product.length>0,'handler-owned git probes were attributed');
const partitions=new Map();for(const r of product){const key=r.pid+':'+r.epoch+':'+(r.scope||'unscoped');if(!partitions.has(key))partitions.set(key,[]);partitions.get(key).push(r);}
// A git mutation issued by this process starts a new generation: reads after it are fresh observations.
const READ_ONLY=/^(?:rev-parse|for-each-ref|merge-base|ls-tree|diff|status|log|show|ls-files|var|config --|check-attr|cat-file|rev-list|describe|name-rev|worktree list|symbolic-ref -q)\b/;
const mutating=argv=>!READ_ONLY.test(argv.replace(/^(?:-c \S+ )+/,''));
let duplicateGitProbes=0,duplicateGitMs=0,mutations=0;const owners={},commands={},scopes={};
for(const group of partitions.values()){let seen=new Map();for(const r of group){if(mutating(r.argv)){mutations++;seen=new Map();continue;}const key=r.cwd+'\0'+r.argv;const n=(seen.get(key)??0)+1;seen.set(key,n);if(n>1){duplicateGitProbes++;duplicateGitMs+=r.ms;owners[r.owner]=(owners[r.owner]??0)+1;scopes[r.scope||'unscoped']=(scopes[r.scope||'unscoped']??0)+1;commands[r.argv.split(' ').slice(0,3).join(' ')]=(commands[r.argv.split(' ').slice(0,3).join(' ')]??0)+1;}}}
const top=o=>Object.fromEntries(Object.entries(o).sort((a,b)=>b[1]-a[1]).slice(0,8));
const metric={directory,elapsedMs:performance.now()-started,gitProbes:probes.length,handlerOwnedProbes:product.length,gitMs:probes.reduce((s,r)=>s+r.ms,0),partitions:partitions.size,mutations,duplicateGitProbes,duplicateGitMs,owners:top(owners),scopes:top(scopes),commands:top(commands),scans:scans.length,duplicateSegmentScans,recoveryPlans,duplicateFileReads,refreshOverBound};
writeFileSync(join(directory,'git-segment.json'),JSON.stringify(metric,null,2)+'\n');console.log('GIT_SEGMENT_METRIC '+JSON.stringify(metric));
assert.deepEqual({duplicateGitProbes,duplicateSegmentScans,recoveryPlans,duplicateFileReads,refreshOverBound},{duplicateGitProbes:0,duplicateSegmentScans:0,recoveryPlans:0,duplicateFileReads:0,refreshOverBound:0},'GIT_SEGMENT_RED: one synchronous segment probes the same git state more than once');
console.log('GIT_SEGMENT_GREEN');
