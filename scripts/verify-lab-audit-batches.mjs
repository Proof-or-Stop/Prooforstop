import assert from 'node:assert/strict';
import * as audit from './lab-audit.mjs';
assert.equal(typeof audit.planAuditBatches,'function','LAB_AUDIT_BATCHING_MISSING: large candidates need exhaustive bounded review batches');
const files=Array.from({length:55},(_,i)=>({path:`modules/family-${Math.floor(i/15)}/file-${i}.mjs`,content:'export const value=1;'}));
const plan=audit.planAuditBatches(files);
assert.ok(plan.length>1);
assert.deepEqual(plan.flatMap(batch=>batch.paths).sort(),files.map(file=>file.path).sort());
assert.ok(plan.every(batch=>batch.paths.length<=24));
assert.deepEqual(plan,audit.planAuditBatches([...files].reverse()));
assert.throws(()=>audit.planAuditBatches([...files,files[0]]),/duplicate/);
console.log('LAB_AUDIT_BATCH_PLAN_GREEN exhaustive, bounded, deterministic and duplicate refusal');
const binding={schemaVersion:audit.LAB_AUDIT_SCHEMA,labName:'fixture',head:'head',base:'base',inputDigest:'input',configDigest:'config',developerHost:'codex',auditorHost:'fixture',developerVendor:'openai',auditorVendor:'independent'};
const {createHash}=await import('node:crypto');
const digest=createHash('sha256').update(JSON.stringify(plan)).digest('hex');
const paths=files.map(file=>file.path);
const records=[...plan.map(batch=>batch.paths),paths].map((readRefs,index)=>({...binding,runId:`run-${index}`,batchIndex:index,batchKind:index===plan.length?'integration':'module',batchPlanDigest:digest,decision:'pass',findings:[],readRefs,process:{exitCode:0,closeObserved:true,replacementSafe:true,processCleanup:{reaped:true,residualProcessGroup:false}}}));
assert.equal(audit.validateAuditBatchRecords(records,plan,paths,binding),true);
for(const mutate of [rows=>rows.pop(),rows=>rows[0].readRefs.pop(),rows=>rows[0].head='stale',rows=>rows[0].decision='fail',rows=>rows[0].findings.push({problem:'defect'}),rows=>rows[0].process.processCleanup.reaped=false,rows=>rows[0].batchPlanDigest='other',rows=>rows[1].runId=rows[0].runId]) {
 const copy=structuredClone(records);mutate(copy);assert.throws(()=>audit.validateAuditBatchRecords(copy,plan,paths,binding),/batch/);
}
assert.equal(audit.auditIsFresh(records[0],binding),false);
console.log('LAB_AUDIT_BATCH_GATES_GREEN omission, stale candidate, failure, findings, cleanup, plan and reused-run refusals');
const {mkdtempSync,writeFileSync,readFileSync,rmSync,mkdirSync}=await import('node:fs');
const {tmpdir}=await import('node:os');
const {join}=await import('node:path');
const {execFileSync}=await import('node:child_process');
const dir=mkdtempSync(join(tmpdir(),'lab-batch-fixture-'));
const git=(...args)=>execFileSync('git',args,{cwd:dir,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
try {
 git('init','-b','main');git('config','user.name','Lab fixture');git('config','user.email','fixture@example.invalid');
 writeFileSync(join(dir,'base.txt'),'base');writeFileSync(join(dir,'dependency.mjs'),'export const value=1;');mkdirSync(join(dir,'docs'));writeFileSync(join(dir,'docs','reference.md'),'Durable unchanged evidence.');git('add','.');git('commit','-m','baseline');const base=git('rev-parse','HEAD');
 mkdirSync(join(dir,'modules'));
 for(let i=0;i<25;i++)writeFileSync(join(dir,'modules',`${i}.mjs`),i===0?"import {value} from '../dependency.mjs'; // [evidence](../docs/reference.md)\nexport const n=value;":'export const n=1;');
 git('add','.');git('commit','-m','candidate');const head=git('rev-parse','HEAD');
 assert.ok(audit.auditInput(dir,base,head).tree?.some(row=>row.path==='docs/reference.md'),'LAB_AUDIT_UNCHANGED_CONTEXT_MISSING: omitted snapshot does not mean absent repository file');
 const adapter=join(dir,'adapter.cjs');
 writeFileSync(adapter,`const fs=require('node:fs');const p=fs.readFileSync(0,'utf8');const b=JSON.parse(p.split('Binding: ')[1].split('\\nSchema:')[0]);const data=JSON.parse(p.split('Untrusted audit input:\\n')[1]);for(const f of data.files)fs.readFileSync('snapshot/'+f.path);const refs=data.files.map(f=>f.path);if(process.argv[2]==='omit')refs.pop();console.log(JSON.stringify({...b,decision:'pass',findings:[],summary:'Disposable synthetic transport verification; not actual independent approval.',readRefs:refs}));`);
 const selection={developer:{id:'codex',vendor:'openai'},auditor:{id:'fixture',vendor:'independent',command:process.execPath,argv:[adapter],protocol:'lab-json'}};
 const options={cwd:dir,base,head,developer:'codex',labName:'batches-fixture',evidenceRoot:join(dir,'evidence'),selection};
 const result=await audit.executeLabAudit(options);
 assert.equal(result.batches.length,3);
 assert.equal(result.readRefs.length,25);
 const expected={labName:options.labName,head,base,inputDigest:audit.auditInput(dir,base,head).inputDigest,developerVendor:'openai',auditorVendor:'independent'};
 assert.equal(audit.auditIsFresh(result,expected),true);
 const missing=structuredClone(result);missing.batches.pop();assert.equal(audit.auditIsFresh(missing,expected),false);
 const prompt=readFileSync(join(result.batches.at(-1).evidenceDir,'prompt.txt'),'utf8');assert.match(prompt,/cross-module integration review/);
 await assert.rejects(()=>audit.executeLabAudit({...options,selection:{...selection,auditor:{...selection.auditor,argv:[adapter,'omit']}}}),/omitted changed-file/);
 console.log('LAB_AUDIT_BATCH_TRANSPORT_GREEN real disposable provider processes, complete aggregation and missing-reference refusal');
} finally {rmSync(dir,{recursive:true,force:true});}
