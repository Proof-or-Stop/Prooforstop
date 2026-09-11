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
 const commands=['build','unaffected'].map(label=>({label,command:process.execPath,args:label==='build'?['-e',"console.log('build marker')"]:['-e',"const a=require('node:assert/strict');const f=require('./tests/unaffected.json');a.equal(f.input,f.expected);a.notEqual(process.argv.at(-1),'fault-selector','paired selector defect');a.equal(process.env.U09_ACTUAL_DECLARED_INPUT,'A','paired environment defect');console.log('unaffected marker',JSON.stringify({effective:process.env.U09_ACTUAL_DECLARED_INPUT??null}))",'tests/unaffected.json'],assurance:'story-selectable',riskTier:'local',closurePolicy:'static-and-traced',fullBaselineReusePolicy:'not-applicable',...(overlay?{env:{[KEY]:'fixed'}}:{}),declaredEnvironmentKeys:['FORCE_COLOR','PROOF_OR_STOP_RUNTIME_TRACE_FILE',KEY]}));
 write('proof-or-stop.config.json',JSON.stringify({scanRoot:'packages/main',rootDir:'src',validate:{dynamic:{mode:'enforce-low-risk'},commands}}));
 git('init','-q','-b','main');git('config','user.name','Audit');git('config','user.email','audit@example.invalid');git('add','.');git('commit','-qm','actual baseline');process.chdir(root);
 const head=git('rev-parse','HEAD'),configured=configuredValidationCommands(root);
 const baseline=await executeValidationPlan({provider:'full-baseline',commands:configured,warnings:[]},root,head,storyId);
 assert.equal(baseline.allPass,true);assert.ok(persistCanonicalFullBaseline({projectRoot:root,sourceHead:head,result:baseline,commands:configured}));
 const warm=await runStoryAwareDynamicValidation({projectRoot:root,gitCwd:root,storyId,baseHead:head,head,mode:'enforce-low-risk',commands:configured});
 assert.equal(warm.authority.authoritative,true);assert.equal(warm.dynamicAllPass,true);
 const target=warm.catalog.find(c=>c.label==='unaffected'),genuine=warm.receipts.find(r=>r.commandId===target.id);
 assert.ok(genuine);assert.equal(verifyValidationCommandReceipt(genuine).ok,true);

 const selectedCommands=configured.map(c=>c.label==='unaffected'?{...c,args:[...c.args,'fault-selector']}:c);
 const before=git('rev-parse','HEAD');
 const whole=await executeValidationPlan({provider:'paired-full',commands:selectedCommands,warnings:[]},root,head,storyId);
 const scoped=await runStoryAwareDynamicValidation({projectRoot:root,gitCwd:root,storyId,baseHead:head,head,mode:'enforce-low-risk',commands:selectedCommands});
 const fullFailure=whole.commands.find(c=>c.label==='unaffected');
 const scopedFailure=scoped.selectedResult.commands.find(c=>c.label==='unaffected');
 assert.equal(whole.allPass,false);assert.equal(scoped.dynamicAllPass,false);
 for(const result of [fullFailure,scopedFailure]){
  assert.ok(result,'faulted command must actually execute');assert.notEqual(result.code,0);
  assert.match(result.output,/paired selector defect/,'both executions detect identical assertion defect');
 }
 assert.equal(git('rev-parse','HEAD'),before);assert.equal(git('status','--porcelain'),'');
 console.log(JSON.stringify({caseId:'SELECTOR-01',head:before,full:{detected:true,code:fullFailure.code},scoped:{detected:true,code:scopedFailure.code},scope:'one predefined paired witness; not population noninferiority'}));
}finally{if(oldValue===undefined)delete process.env[KEY];else process.env[KEY]=oldValue;process.chdir(old);rmSync(root,{recursive:true,force:true});}
