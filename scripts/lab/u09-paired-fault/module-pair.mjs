#!/usr/bin/env node
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
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
 const caseId=process.env.U09_CASE||'GATE-01';
 const production=caseId==='POLICY-01'?'command-policy':caseId==='GATE-01'?'scope-inventory-budget':null;
 const targetPath=production?`packages/main/src/core/${production}.ts`:'tests/dependency.mjs';
 const healthy=production?readFileSync(join(repo,'packages/main/src/core',production+'.ts'),'utf8'):'export const value=1;';
 write(targetPath,healthy);
 const assertion=caseId==='POLICY-01'?"a.equal(m.getCommandLifecyclePolicy('story_create')?.ownershipClass,'mainSharedMutating','paired policy defect')":caseId==='GATE-01'?"a.doesNotThrow(()=>m.validateScopeInventoryBudget({allowedModify:['a','b'],allowedCreate:[],allowedTest:[],protectedFiles:[],explicitExcludes:[]}),'paired gate defect')":"a.equal(m.value,1,'paired dependency defect')";
 const commands=['build','unaffected','sentinel'].map(label=>({label,command:process.execPath,args:label==='unaffected'?['--input-type=module','-e',`import a from 'node:assert/strict';import * as m from './${targetPath}';${assertion};console.log('healthy assertion');`,targetPath]:['-e',`console.log('${label} marker')`],assurance:'story-selectable',riskTier:'local',closurePolicy:'static-and-traced',fullBaselineReusePolicy:'not-applicable',declaredEnvironmentKeys:['FORCE_COLOR','PROOF_OR_STOP_RUNTIME_TRACE_FILE','WATCH_REPORT_DEPENDENCIES','NODE_V8_COVERAGE']}));
 write('proof-or-stop.config.json',JSON.stringify({scanRoot:'packages/main',rootDir:'src',validate:{dynamic:{mode:'enforce-low-risk'},commands}}));
 git('init','-q','-b','main');git('config','user.name','Audit');git('config','user.email','audit@example.invalid');git('add','.');git('commit','-qm','healthy baseline');process.chdir(root);
 const head=git('rev-parse','HEAD'),configured=configuredValidationCommands(root);
 const baseline=await executeValidationPlan({provider:'full-baseline',commands:configured,warnings:[]},root,head,storyId);
 assert.equal(baseline.allPass,true,JSON.stringify(baseline.commands));assert.ok(persistCanonicalFullBaseline({projectRoot:root,sourceHead:head,result:baseline,commands:configured}));
 const warm=await runStoryAwareDynamicValidation({projectRoot:root,gitCwd:root,storyId,baseHead:head,head,mode:'enforce-low-risk',commands:configured});
 if(!warm.authority.authoritative)console.error(readFileSync(join(root,".proof-or-stop/runtime/dynamic-validation/canonical-baseline.json"),"utf8"));assert.equal(warm.authority.authoritative,true,JSON.stringify(warm.authority));assert.equal(warm.dynamicAllPass,true);
 let mutant=caseId==='POLICY-01'?healthy.replace('return COMMAND_POLICIES[command as KnownCommandName];','return undefined;'):caseId==='GATE-01'?healthy.replace('pathsPerList: 4096','pathsPerList: 1'):healthy.replace('value=1','value=2');
 assert.notEqual(mutant,healthy);write(targetPath,mutant);
 if(caseId==='UNKNOWN-01')write('unknown-area/unmapped.txt','unknown fault-associated path');
 git('add','.');git('commit','-qm',caseId+' mutation');const currentHead=git('rev-parse','HEAD');
 const whole=await executeValidationPlan({provider:'paired-full',commands:configured,warnings:[]},root,currentHead,storyId);
 const scopeContract=undefined;
 const scoped=await runStoryAwareDynamicValidation({projectRoot:root,gitCwd:root,storyId,baseHead:head,head:currentHead,mode:'enforce-low-risk',commands:configured,scopeContract});
 assert.equal(whole.allPass,false);assert.equal(scoped.dynamicAllPass,false);
 const f=whole.commands.find(c=>c.label==='unaffected'),d=scoped.selectedResult.commands.find(c=>c.label==='unaffected');
 for(const r of [f,d]){assert.ok(r);assert.notEqual(r.code,0);assert.match(r.output,/paired (policy|gate|dependency) defect/);}
 console.log(JSON.stringify({observedCase:caseId,fullEscalated:scoped.manifest.fullEscalated,reasons:scoped.manifest.escalationReasons,full:whole.commands.map(c=>({label:c.label,code:c.code,output:c.output})),scoped:[...scoped.buildResult.commands,...scoped.selectedResult.commands].map(c=>({label:c.label,code:c.code,output:c.output}))}));
 if(caseId==='DEP-01'){assert.equal(scoped.manifest.fullEscalated,false,'unrelated authority-free dependency remains selective');assert.ok(!scoped.selectedResult.commands.some(c=>c.label==='sentinel'),'unaffected sentinel is omitted');}
 if(caseId==='GATE-01')assert.ok(scoped.manifest.escalationReasons.includes('authority-source-changed:'+targetPath),'direct registered gate authority is identified');
 if(['POLICY-01','GATE-01','UNKNOWN-01'].includes(caseId)){assert.equal(scoped.manifest.fullEscalated,true,'U09_GATE_AUTOMATIC_FULL_REQUIRED '+JSON.stringify(scoped.manifest));assert.deepEqual([...scoped.buildResult.commands,...scoped.selectedResult.commands].map(c=>c.label),configured.map(c=>c.label));}
 console.log(JSON.stringify({caseId,productionModule:production,mutation:{healthySha256:createHash('sha256').update(healthy).digest('hex'),mutantSha256:createHash('sha256').update(mutant).digest('hex'),before:healthy.length,after:mutant.length},fullEscalated:scoped.manifest.fullEscalated,reasons:scoped.manifest.escalationReasons,full:whole.commands.map(c=>({label:c.label,code:c.code,output:c.output})),scoped:[...scoped.buildResult.commands,...scoped.selectedResult.commands].map(c=>({label:c.label,code:c.code,output:c.output}))}));
}finally{if(oldValue===undefined)delete process.env[KEY];else process.env[KEY]=oldValue;process.chdir(old);rmSync(root,{recursive:true,force:true});}
