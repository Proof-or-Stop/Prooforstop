import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,realpathSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
const dist=(process.env.U09_REPO || process.cwd())+'/packages/main/dist/';
const {configuredValidationCommands}=await import(dist+'handlers/verifier.js');
const {executeValidationPlan}=await import(dist+'core/validation-executor.js');
const {persistCanonicalFullBaseline,runStoryAwareDynamicValidation}=await import(dist+'handlers/story-aware-validation.js');
const [rootArg,mode]=process.argv.slice(2);const root=realpathSync(rootArg);process.chdir(root);
const head=execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim();
const commands=configuredValidationCommands(root);
if(mode==='baseline'){
 const result=await executeValidationPlan({provider:'full-baseline',commands,warnings:[]},root,head,'B-asof-run');
 assert.equal(result.allPass,true);assert.ok(persistCanonicalFullBaseline({projectRoot:root,sourceHead:head,result,commands}));
 await runStoryAwareDynamicValidation({projectRoot:root,gitCwd:root,storyId:'B-asof-run',baseHead:head,head,mode:'enforce-low-risk',commands});
 console.log('U09_BASELINE_CLOSURES',JSON.stringify(JSON.parse(readFileSync(root+'/.proof-or-stop/runtime/dynamic-validation/canonical-baseline.json','utf8')).closureCertificates));
 writeFileSync(root+'/u09-base-head.txt',head);
}else{
 const baseHead=readFileSync(root+'/u09-base-head.txt','utf8');
 const status=execFileSync('git',['status','--porcelain'],{cwd:root,encoding:'utf8'}).trim();
 assert.equal(status,'','cross-commit positive requires actual clean current tree');
 assert.notEqual(head,baseHead,'positive must cross a real child commit');
 execFileSync('git',['merge-base','--is-ancestor',baseHead,head],{cwd:root});
 console.log('U09_PROVENANCE',JSON.stringify({baseHead,head,clean:true,ancestor:true}));
 const affected=await runStoryAwareDynamicValidation({projectRoot:root,gitCwd:root,storyId:'B-asof-run',baseHead,head,mode:'enforce-low-risk',commands});
 console.log('U09_DYNAMIC',JSON.stringify({totals:affected.manifest.totals,rows:affected.manifest.rows,reasons:affected.manifest.escalationReasons,authority:affected.authority}));
 const whole=await executeValidationPlan({provider:'full-comparison',commands,warnings:[]},root,head,'B-asof-run');
 assert.equal(whole.allPass,false); assert.equal(affected.dynamicAllPass,false);
 assert.deepEqual(whole.commands.map(c=>[c.label,c.code]),[['build',0],['affected',1],['unaffected',0]],'full oracle must fail only the injected expectation mismatch');
 assert.deepEqual([...affected.buildResult.commands,...affected.selectedResult.commands].map(c=>[c.label,c.code]),[['build',0],['affected',1]],'affected execution must detect the same defect without an unrelated command');
 console.log('U09_COMMANDS',JSON.stringify({whole:whole.commands.map(c=>({label:c.label,code:c.code})),affected:[...affected.buildResult.commands,...affected.selectedResult.commands].map(c=>({label:c.label,code:c.code})),totals:affected.manifest.totals}));
 assert.equal(affected.authority.authoritative,true,'dynamic authority must accept the complete declared baseline');
 assert.deepEqual([...affected.buildResult.commands,...affected.selectedResult.commands].map(c=>c.label),['build','affected']);
 assert.equal(affected.manifest.totals.reused,1);
}
