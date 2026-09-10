#!/usr/bin/env node
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,realpathSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve,join} from 'node:path';
import {execFileSync} from 'node:child_process';
const repo=resolve(process.env.U09_REPO||process.argv[2]||process.cwd());
const load=p=>import(join(repo,'packages/main/dist',p));
const {executeValidationPlan}=await load('core/validation-executor.js');
const {configuredValidationCommands}=await load('handlers/verifier.js');
const {persistCanonicalFullBaseline,runStoryAwareDynamicValidation,prepareStoryAwareValidation}=await load('handlers/story-aware-validation.js');
const {VALIDATION_SOURCE_PROVENANCE_SCHEMA}=await load('core/runtime-fact-registry.js');
const {createValidationCommandReceipt,verifyValidationCommandReceipt,stableDigest}=await load('core/story-aware-validation.js');
const root=realpathSync(mkdtempSync(join(tmpdir(),'u09-provenance-'))),old=process.cwd(),results=[];
const git=(...args)=>execFileSync('git',args,{cwd:root,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
const write=(p,v)=>{mkdirSync(join(root,p,'..'),{recursive:true});writeFileSync(join(root,p),v);};
const storyId='B-u09-provenance';
try{
 write('packages/main/src/core/validation-runtime-tracer.cjs',readFileSync(join(repo,'packages/main/dist/core/validation-runtime-tracer.cjs')));
 write('tests/unaffected.json','{"input":1,"expected":1}');write('notes.txt','initial\n');
 write('.gitignore','.proof-or-stop/runtime/\n.proof-or-stop/locks/\n');
 const commands=['build','unaffected'].map(label=>({label,command:process.execPath,args:label==='build'?['-e',"console.log('build marker')"]:['-e',"const a=require('node:assert/strict');const f=require('./tests/unaffected.json');a.equal(f.input,f.expected);console.log('unaffected marker')",'tests/unaffected.json'],assurance:'story-selectable',riskTier:'local',closurePolicy:'static-and-traced',fullBaselineReusePolicy:'not-applicable',declaredEnvironmentKeys:['FORCE_COLOR','PROOF_OR_STOP_RUNTIME_TRACE_FILE']}));
 write('proof-or-stop.config.json',JSON.stringify({scanRoot:'packages/main',rootDir:'src',validate:{dynamic:{mode:'enforce-low-risk'},commands}}));
 git('init','-q','-b','main');git('config','user.name','Audit');git('config','user.email','audit@example.invalid');git('add','.');git('commit','-qm','actual baseline');process.chdir(root);
 const head=git('rev-parse','HEAD'),configured=configuredValidationCommands(root);
 const baseline=await executeValidationPlan({provider:'full-baseline',commands:configured,warnings:[]},root,head,storyId);
 assert.equal(baseline.allPass,true);assert.ok(persistCanonicalFullBaseline({projectRoot:root,sourceHead:head,result:baseline,commands:configured}));
 const warm=await runStoryAwareDynamicValidation({projectRoot:root,gitCwd:root,storyId,baseHead:head,head,mode:'enforce-low-risk',commands:configured});
 assert.equal(warm.authority.authoritative,true);assert.equal(warm.dynamicAllPass,true);
 const target=warm.catalog.find(c=>c.label==='unaffected'),genuine=warm.receipts.find(r=>r.commandId===target.id);
 assert.ok(genuine);assert.equal(verifyValidationCommandReceipt(genuine).ok,true);
 const prepare=(receipt,current=head)=>prepareStoryAwareValidation({projectRoot:root,gitCwd:root,storyId,baseHead:head,head:current,mode:'enforce-low-risk',commands:configured,receipts:receipt?[receipt]:[],revocationLedger:warm.revocationLedger,buildProofDigest:genuine.buildProofDigest});
 const row=p=>p.manifest.rows.find(r=>r.commandId===target.id);
 assert.equal(row(prepare(genuine)).disposition,'reuse','control: actual same-head receipt must be admissible');
 const signedNegative=fields=>{const {schema,signature,...body}=genuine;return createValidationCommandReceipt({...body,...fields});};
 const cases=[
  ['tampered-cleanliness',{...genuine,cleanTreeDigest:'altered-without-resigning'}],
  ['missing-cleanliness',signedNegative({cleanTreeDigest:''})],
  ['signed-dirty-history',signedNegative({cleanTreeDigest:stableDigest({head,storyId,status:'dirty'})})],
  ['signed-wrong-head-cleanliness',signedNegative({cleanTreeDigest:stableDigest({head:'a'.repeat(40),storyId,status:'clean-at-command-start-and-end',provenanceSchema:VALIDATION_SOURCE_PROVENANCE_SCHEMA})})],
  ['missing-source-head',signedNegative({sourceHead:''})],
  ['missing-receipt',undefined],
 ];
 for(const [name,receipt]of cases){const selected=row(prepare(receipt));results.push({name,disposition:selected.disposition,reasons:selected.reasons,pass:selected.disposition==='execute'});}
 // Validly signed negative is intentionally not positive execution evidence.
 const nonancestor=execFileSync('git',['commit-tree',git('rev-parse','HEAD^{tree}'),'-m','nonancestor negative'],{cwd:root,encoding:'utf8'}).trim();
 assert.notEqual(nonancestor,head);
 const alien=signedNegative({sourceHead:nonancestor,cleanTreeDigest:stableDigest({head:nonancestor,storyId,status:'clean-at-command-start-and-end',provenanceSchema:VALIDATION_SOURCE_PROVENANCE_SCHEMA})});
 const alienRow=row(prepare(alien));results.push({name:'nonancestor',disposition:alienRow.disposition,reasons:alienRow.reasons,pass:alienRow.disposition==='execute'});
 write('notes.txt','dirty unrelated change\n');
 const dirty=row(prepare(genuine));results.push({name:'current-dirty',disposition:dirty.disposition,reasons:dirty.reasons,pass:dirty.disposition==='execute'});
 const dirtyRun=await runStoryAwareDynamicValidation({projectRoot:root,gitCwd:root,storyId:'B-u09-dirty-issuer',baseHead:head,head,mode:'enforce-low-risk',commands:configured});
 assert.ok([...dirtyRun.buildResult.commands,...dirtyRun.selectedResult.commands].every(c=>c.code===0),'preexisting dirty source still permits ordinary command execution');
 assert.equal(dirtyRun.receipts.length,0,'successful execution on preexisting dirty source must not mint clean reusable evidence');
 results.push({name:'dirty-source-receipt-issuance',pass:true});
 write('notes.txt','initial\n');assert.equal(git('status','--porcelain'),'');
 write('tests/unaffected.json','{"input":1,"expected":2}');git('add','tests/unaffected.json');git('commit','-qm','change certified input');
 const changedHead=git('rev-parse','HEAD'),changed=row(prepare(genuine,changedHead));
 results.push({name:'changed-certified-input',disposition:changed.disposition,reasons:changed.reasons,pass:changed.disposition==='execute'});
 const actual=await runStoryAwareDynamicValidation({projectRoot:root,gitCwd:root,storyId,baseHead:head,head:changedHead,mode:'enforce-low-risk',commands:configured});
 assert.deepEqual([...actual.buildResult.commands,...actual.selectedResult.commands].map(c=>[c.label,c.code]),[['build',0],['unaffected',1]],'changed certified input executes and catches actual defect');
 console.log(JSON.stringify({control:'actual baseline + warm receipt, same-head reuse',results},null,2));
 assert.ok(results.every(r=>r.pass),'all negative provenance witnesses must refuse reuse');
}finally{process.chdir(old);rmSync(root,{recursive:true,force:true});}
