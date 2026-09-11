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
const {createValidationCommandReceipt,verifyValidationCommandReceipt,stableDigest}=await load('core/story-aware-validation.js');
const root=realpathSync(mkdtempSync(join(tmpdir(),'u09-provenance-'))),old=process.cwd(),results=[];
const git=(...args)=>execFileSync('git',args,{cwd:root,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
const write=(p,v)=>{mkdirSync(join(root,p,'..'),{recursive:true});writeFileSync(join(root,p),v);};
const storyId='B-u09-provenance';
const KEY='U09_ACTUAL_DECLARED_INPUT';const oldValue=process.env[KEY];const overlay=process.argv.includes('--overlay');process.env[KEY]='A';
try{
 write('packages/main/src/core/validation-runtime-tracer.cjs',readFileSync(join(repo,'packages/main/dist/core/validation-runtime-tracer.cjs')));
 write('tests/unaffected.json','{"input":1,"expected":1}');write('notes.txt','initial\n');
 write('.gitignore','.proof-or-stop/runtime/\n.proof-or-stop/locks/\n');
 const commands=['build','unaffected'].map(label=>({label,command:process.execPath,args:label==='build'?['-e',"console.log('build marker')"]:['-e',"const a=require('node:assert/strict');const f=require('./tests/unaffected.json');a.equal(f.input,f.expected);console.log('unaffected marker',JSON.stringify({effective:process.env.U09_ACTUAL_DECLARED_INPUT??null}))",'tests/unaffected.json'],assurance:'story-selectable',riskTier:'local',closurePolicy:'static-and-traced',fullBaselineReusePolicy:'not-applicable',...(overlay?{env:{[KEY]:'fixed'}}:{}),declaredEnvironmentKeys:['FORCE_COLOR','PROOF_OR_STOP_RUNTIME_TRACE_FILE',KEY]}));
 write('proof-or-stop.config.json',JSON.stringify({scanRoot:'packages/main',rootDir:'src',validate:{dynamic:{mode:'enforce-low-risk'},commands}}));
 git('init','-q','-b','main');git('config','user.name','Audit');git('config','user.email','audit@example.invalid');git('add','.');git('commit','-qm','actual baseline');process.chdir(root);
 const head=git('rev-parse','HEAD'),configured=configuredValidationCommands(root);
 const baseline=await executeValidationPlan({provider:'full-baseline',commands:configured,warnings:[]},root,head,storyId);
 assert.equal(baseline.allPass,true);assert.ok(persistCanonicalFullBaseline({projectRoot:root,sourceHead:head,result:baseline,commands:configured}));
 const warm=await runStoryAwareDynamicValidation({projectRoot:root,gitCwd:root,storyId,baseHead:head,head,mode:'enforce-low-risk',commands:configured});
 assert.equal(warm.authority.authoritative,true);assert.equal(warm.dynamicAllPass,true);
 const target=warm.catalog.find(c=>c.label==='unaffected'),genuine=warm.receipts.find(r=>r.commandId===target.id);
 assert.ok(genuine);assert.equal(verifyValidationCommandReceipt(genuine).ok,true);

 const prepare=receipt=>prepareStoryAwareValidation({projectRoot:root,gitCwd:root,storyId,baseHead:head,head,mode:'enforce-low-risk',commands:configured,receipts:[receipt],revocationLedger:warm.revocationLedger,buildProofDigest:receipt.buildProofDigest});
 const row=p=>p.manifest.rows.find(r=>r.commandId===target.id);
 assert.equal(row(prepare(genuine)).disposition,'reuse','same-head actual receipt positive');
 process.env[KEY]='B';
 const changed=row(prepare(genuine));
 console.log(JSON.stringify({case:overlay?'overlay-unchanged':'ambient-changed',disposition:changed.disposition,reasons:changed.reasons}));
 assert.equal(changed.disposition,overlay?'reuse':'execute');
 if(!overlay){
  const executeFresh=async(previous,expected)=>{
   const selected=row(prepare(previous));assert.equal(selected.disposition,'execute');
   const run=await runStoryAwareDynamicValidation({projectRoot:root,gitCwd:root,storyId,baseHead:head,head,mode:'enforce-low-risk',commands:configured});
   const actual=run.selectedResult.commands.find(c=>c.label==='unaffected');assert.ok(actual);assert.equal(actual.code,0);assert.ok(actual.output.includes(JSON.stringify({effective:expected})),'actual child observes expected environment');
   const receipt=run.receipts.find(r=>r.commandId===target.id&&r.inputDigest===selected.inputDigest);
   assert.ok(receipt);assert.equal(verifyValidationCommandReceipt(receipt).ok,true);assert.notEqual(receipt.inputDigest,previous.inputDigest);
   return receipt;
  };
  const b=await executeFresh(genuine,'B');
  delete process.env[KEY];const absent=await executeFresh(b,null);
  process.env[KEY]='';const empty=await executeFresh(absent,'');
  assert.equal(row(prepare(empty)).disposition,'reuse');
  console.log('PASS declared environment actual B/absent/empty execution receipts differ and latest reuses');
 }
 console.log('PASS U09 actual declared environment '+(overlay?'overlay':'ambient'));
}finally{if(oldValue===undefined)delete process.env[KEY];else process.env[KEY]=oldValue;process.chdir(old);rmSync(root,{recursive:true,force:true});}
