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

 const prepare=()=>prepareStoryAwareValidation({projectRoot:root,gitCwd:root,storyId,baseHead:head,head,mode:'enforce-low-risk',commands:configured,receipts:[genuine],revocationLedger:warm.revocationLedger,buildProofDigest:genuine.buildProofDigest});
 const row=()=>prepare().manifest.rows.find(r=>r.commandId===target.id);
 assert.equal(row().disposition,'reuse','actual receipt before replacements reuses');
 const index=join(root,'.git','replacement-index');const alternateGit=(args,input)=>execFileSync('git',args,{cwd:root,encoding:'utf8',input,env:{...process.env,GIT_INDEX_FILE:index},stdio:['pipe','pipe','pipe']}).trim();
 alternateGit(['read-tree',head]);
 const blob=alternateGit(['hash-object','-w','--stdin'],'{"input":2,"expected":2}');
 alternateGit(['update-index','--cacheinfo','100644,'+blob+',tests/unaffected.json']);
 const tree=alternateGit(['write-tree']);
 const replacement=git('commit-tree',tree,'-m','replacement changes certified bytes');
 const observe=name=>{assert.equal(git('rev-parse','HEAD'),head);assert.equal(git('status','--porcelain'),'');assert.equal(JSON.parse(readFileSync(join(root,'tests/unaffected.json'),'utf8')).input,2,'actual clean checkout uses replaced certified bytes');const selected=row();results.push({name,disposition:selected.disposition,reasons:selected.reasons,sourceHeadUnchanged:true,currentWorkingTreeClean:true,actualCertifiedInput:2,receiptCertifiedInput:1});};
 git('replace',head,replacement);git('reset','--hard','HEAD');observe('loose replacement changes historical interpretation');
 git('pack-refs','--all');observe('packed replacement changes historical interpretation');
 git('replace','-d',head);git('reset','--hard','HEAD');assert.equal(row().disposition,'reuse','removing replacement restores original input receipt');
 const oldPrefix=process.env.GIT_REPLACE_REF_BASE;
 try{process.env.GIT_REPLACE_REF_BASE='refs/u09-replacement';git('update-ref','refs/u09-replacement'+head,replacement);git('reset','--hard','HEAD');observe('custom prefix replacement');git('update-ref','-d','refs/u09-replacement'+head);git('reset','--hard','HEAD');}
 finally{if(oldPrefix===undefined)delete process.env.GIT_REPLACE_REF_BASE;else process.env.GIT_REPLACE_REF_BASE=oldPrefix;}
 assert.equal(row().disposition,'reuse','restored namespace and original clean tree reuse again');
 console.log(JSON.stringify({control:'actual executor receipt for input1, clean replacement checkout input2 with same HEAD',results},null,2));
 assert.ok(results.every(r=>r.disposition==='execute'),'replacement-based historical reinterpretation must never reuse the old receipt');
}finally{process.chdir(old);rmSync(root,{recursive:true,force:true});}
