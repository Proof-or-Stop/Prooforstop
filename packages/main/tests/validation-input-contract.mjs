import assert from 'node:assert/strict';
import fs from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,symlinkSync,chmodSync,openSync,closeSync,ftruncateSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {execFileSync} from 'node:child_process';
import {createServer} from 'node:net';
import {snapshotValidationExecutionInputs as snapshot,VALIDATION_INPUT_LIMITS as limits} from '../dist/core/validation-execution-inputs.js';
import {sharedValidationReuseAllowed as allowed,sharedValidationReusePolicy as policy,executeSharedValidationCommand} from '../dist/core/shared-validation-execution.js';
import {summarizeRoutineCommandExecution as summarize} from '../dist/core/validation-evidence-reuse.js';
const oldAllowed = c => c.executionReuse==='exact-inputs' && Array.isArray(c.executionInputs) && c.executionInputs.every(p=>typeof p==='string'&&p.trim().length>0) && c.fullBaselineReusePolicy!=='forbidden' && c.closurePolicy!=='never-reuse' && c.riskTier!=='gate' && c.riskTier!=='validation-infra' && !c.requiresBuildProof && !c.providesBuildProof && !c.proof;
let combinations=0;
const specimens=[];
for(const riskTier of [undefined,'local','shared','gate','validation-infra','invalid'])
for(const closurePolicy of [undefined,'static-and-traced','whole-repository','never-reuse','invalid'])
for(const fullBaselineReusePolicy of [undefined,'not-applicable','exact-current-epoch-only','forbidden','invalid'])
for(const executionReuse of [undefined,'exact-inputs','invalid'])
for(const executionInputs of [undefined,[],['file'],[''],[' '],'file',[4]])
for(let flags=0;flags<8;flags++) {
 const c={riskTier,closurePolicy,fullBaselineReusePolicy,executionReuse,executionInputs,requiresBuildProof:!!(flags&1),providesBuildProof:!!(flags&2),proof:!!(flags&4)};
 assert.equal(policy(c).eligible,oldAllowed(c));assert.equal(allowed(c),oldAllowed(c));combinations++;
 if(combinations%101===0)specimens.push(c);
}
const eligible={command:process.execPath,args:['-e',''],executionReuse:'exact-inputs',executionInputs:[]};
for(const [extra,reason] of [[{proof:true},'build_proof_required'],[{fullBaselineReusePolicy:'forbidden'},'policy_forbidden'],[{closurePolicy:'never-reuse'},'policy_never_reuse'],[{riskTier:'gate'},'policy_risk_tier'],[{executionReuse:undefined},'not_opted_in'],[{executionInputs:['']},'inputs_undeclared'],[{},'eligible']])assert.equal(policy({...eligible,...extra}).reason,reason);
// The DONE-required consumer uses this exact boolean to select admission branches.
// Both already-admitted and non-admitted contexts must retain the same decision.
for(const admitted of [false,true])for(const commands of [[],[eligible],specimens,[{...eligible,proof:true}]]){
 const before=commands.some(oldAllowed),after=commands.some(allowed);assert.equal(after,before);
 assert.deepEqual({needsAdmission:!admitted&&after,commitsAdmissionForReuse:after},{needsAdmission:!admitted&&before,commitsAdmissionForReuse:before});
}
const result={label:'witness',command:process.execPath,args:[],code:0,output:'PASS'};
assert.deepEqual(summarize([result],1),summarize([{...result,executionDecision:{disposition:'executed',reason:'input_unreadable'}}],1));
const ordinary=await executeSharedValidationCommand(eligible,process.cwd(),1000,async()=>result);
assert.equal(ordinary,result);assert.equal(Object.hasOwn(ordinary,'executionDecision'),false);
console.log('INPUT_POLICY_EQUIVALENCE_GREEN '+combinations);
const root=mkdtempSync(join(tmpdir(),'pos-input-snapshot-'));const tests=[];
const check=(name,fn)=>{const t=performance.now();fn();tests.push({name,ms:performance.now()-t});};
try {
 const tree=join(root,'tree');mkdirSync(tree);writeFileSync(join(tree,'entry'),'a');
 const first=snapshot(root,['tree']);assert.deepEqual(snapshot(root,['tree']),first);
 check('added-and-removed',()=>{writeFileSync(join(tree,'added'),'b');assert.notDeepEqual(snapshot(root,['tree']),first);rmSync(join(tree,'added'));assert.deepEqual(snapshot(root,['tree']),first);});
 check('mode',()=>{chmodSync(join(tree,'entry'),0o700);assert.notDeepEqual(snapshot(root,['tree']),first);});
 check('dangling',()=>{symlinkSync(join(root,'missing'),join(tree,'dangling'));assert.throws(()=>snapshot(root,['tree']));rmSync(join(tree,'dangling'));});
 check('cycle',()=>{symlinkSync(tree,join(tree,'cycle'));assert.throws(()=>snapshot(root,['tree']),/cycle/);rmSync(join(tree,'cycle'));});
 check('fifo',()=>{execFileSync('mkfifo',[join(tree,'fifo')]);assert.throws(()=>snapshot(root,['tree']),/unsupported/);rmSync(join(tree,'fifo'));});
 for(const replacement of ['fifo','link'])check('open-swap-'+replacement,()=>{
  const path=join(root,'swap'),target=join(root,'swap-target');writeFileSync(path,'regular');writeFileSync(target,'target');
  const actual=fs.realpathSync(path);const original=fs.openSync;let injected=false;
  fs.openSync=function(p,...args){if(p===actual&&!injected){injected=true;rmSync(path);if(replacement==='fifo')execFileSync('mkfifo',[path]);else symlinkSync(target,path);}return original(p,...args);};syncBuiltinESMExports();
  try{assert.throws(()=>snapshot(root,['swap']));assert.equal(injected,true);}finally{fs.openSync=original;syncBuiltinESMExports();rmSync(path);}
 });
 const socket=join(root,'socket'),server=createServer();await new Promise((r,j)=>{server.once('error',j);server.listen(socket,r)});
 try {check('socket',()=>assert.throws(()=>snapshot(root,['socket']),/unsupported/));} finally {await new Promise(r=>server.close(r));}
 const shared=join(root,'shared');mkdirSync(shared);writeFileSync(join(shared,'entry'),'one');
 const dag=join(root,'dag');mkdirSync(dag);symlinkSync(shared,join(dag,'a'));symlinkSync(shared,join(dag,'b'));
 check('dag-content-and-retarget',()=>{const a=snapshot(root,['dag']);writeFileSync(join(shared,'entry'),'two');assert.notDeepEqual(snapshot(root,['dag']),a);const other=join(root,'other');mkdirSync(other);writeFileSync(join(other,'entry'),'two');const b=snapshot(root,['dag']);rmSync(join(dag,'a'));symlinkSync(other,join(dag,'a'));assert.notDeepEqual(snapshot(root,['dag']),b);});
 check('depth-cap',()=>{let d=join(root,'deep');mkdirSync(d);for(let i=0;i<=limits.depth;i++){d=join(d,'d');mkdirSync(d)}assert.throws(()=>snapshot(root,['deep']),/limit/);});
 check('entry-cap',()=>{const d=join(root,'wide');mkdirSync(d);for(let i=0;i<limits.entries;i++)writeFileSync(join(d,String(i)),'');assert.throws(()=>snapshot(root,['wide']),/limit/);});
 check('byte-cap',()=>{const p=join(root,'large'),fd=openSync(p,'w');ftruncateSync(fd,limits.bytes+1);closeSync(fd);assert.throws(()=>snapshot(root,['large']),/byte limit/);});
 check('dag-amplification-cap',()=>{const target=join(root,'fan-target'),fan=join(root,'fan');mkdirSync(target);mkdirSync(fan);for(let i=0;i<100;i++)writeFileSync(join(target,String(i)),'');for(let i=0;i<50;i++)symlinkSync(target,join(fan,String(i)));assert.throws(()=>snapshot(root,['fan']),/limit/);});
 console.log('INPUT_SNAPSHOT_BOUNDS_GREEN '+JSON.stringify(tests));
} finally {rmSync(root,{recursive:true,force:true});}
