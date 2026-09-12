import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import assert from 'node:assert/strict';import crypto from 'node:crypto';import {createRequire} from 'node:module';import {spawnSync} from 'node:child_process';import {fileURLToPath} from 'node:url';
const repo=fileURLToPath(new URL('..',import.meta.url)),root=fs.mkdtempSync(path.join(os.tmpdir(),'u18-static-boundaries-'));
try{
 fs.writeFileSync(path.join(root,'package.json'),'{}');fs.mkdirSync(path.join(root,'node_modules'));fs.symlinkSync(path.dirname(createRequire(path.join(repo,'package.json')).resolve('typescript/package.json')),path.join(root,'node_modules/typescript'),'dir');
 const commands=[{command:'node',args:['a.mjs']},{command:'node',args:['b.mjs']}];fs.writeFileSync(path.join(root,'proof-or-stop.config.json'),JSON.stringify({validate:{commands}}));fs.writeFileSync(path.join(root,'b.mjs'),'');const manifest=path.join(root,'exceptions.json');fs.writeFileSync(manifest,JSON.stringify({entries:[],configDigest:crypto.createHash('sha256').update(JSON.stringify(commands)).digest('hex')}));
 fs.writeFileSync(path.join(root,'dispatch.mjs'),"import {spawn} from 'node:child_process';spawn(process.execPath,['b.mjs']);");
 const cases={require:"const {spawn}=require('node:child_process');spawn(process.execPath,['b.mjs']);",aliasedArray:"import {spawn} from 'node:child_process';const args=['ordinary.mjs'];const alias=args;alias[0]='b.mjs';spawn(process.execPath,args);",sideEffect:"import './dispatch.mjs';",computed:"import * as cp from 'node:child_process';cp['spawn'](process.execPath,['b.mjs']);",destructured:"import * as cp from 'node:child_process';const {spawn: launch}=cp;launch(process.execPath,['b.mjs']);",parseError:"import { spawn",shadowedBuiltin:"import {spawn} from 'node:child_process';function join(){return 'b.mjs'};spawn(process.execPath,[join('ordinary.mjs')]);",alias:"import {spawn} from 'node:child_process';const launch=spawn;launch(process.execPath,['b.mjs']);",mutable:"import {spawn} from 'node:child_process';let target='ordinary.mjs';target='b.mjs';spawn(process.execPath,[target]);",arrayWrite:"import {spawn} from 'node:child_process';const args=['ordinary.mjs'];args[0]='b.mjs';spawn(process.execPath,args);",npm:"import {spawn} from 'node:child_process';spawn('npm',['run','registered']);"};
 const failures=[];
 for(const [name,source]of Object.entries(cases)){
  fs.writeFileSync(path.join(root,'a.mjs'),source);const result=spawnSync(process.execPath,[path.join(repo,'scripts/verify-validation-static-edges.mjs'),root,manifest],{encoding:'utf8'});
  if(result.status!==1||!result.stdout.includes('U18_STATIC_NEEDS_REVIEW')) failures.push(name+' '+result.stdout+result.stderr);else console.log('PASS static refusal '+name);
 }
 assert.deepEqual(failures,[],'U18_STATIC_ALIAS_MUST_BE_REJECTED '+failures.join(' | '));
 const hash=x=>crypto.createHash('sha256').update(x).digest('hex');
 const reportPath=path.join(root,'report.json');
 const pin=entries=>fs.writeFileSync(manifest,JSON.stringify({entries,configDigest:hash(JSON.stringify(commands))}));
 const save=()=>fs.writeFileSync(path.join(root,'proof-or-stop.config.json'),JSON.stringify({validate:{commands}}));
 const run=()=>{const result=spawnSync(process.execPath,[path.join(repo,'scripts/verify-validation-static-edges.mjs'),root,manifest],{encoding:'utf8',env:{...process.env,U18_STATIC_REPORT_PATH:reportPath}});assert.ok([0,1].includes(result.status),result.stderr);return {...result,report:JSON.parse(fs.readFileSync(reportPath,'utf8'))};};
 const expect=(status,label)=>{const result=run();assert.equal(result.status,status,label+' '+result.stdout+result.stderr);console.log('PASS '+label);return result.report;};
 fs.writeFileSync(path.join(root,'a.mjs'),"import {spawn} from 'node:child_process';import {join as combine} from 'node:path';spawn('git',['status']);spawn(process.execPath,[combine('ordinary.mjs')]);");
 expect(0,'ordinary CLI and imported builtin remain allowed');
 const guarded="import {spawn} from 'node:child_process';if(!process.argv.includes('--canonical-core'))spawn(process.execPath,['b.mjs']);";
 fs.writeFileSync(path.join(root,'a.mjs'),guarded);commands[0].args.push('--canonical-core');save();pin([]);
 assert.equal(expect(0,'canonical branch excludes combined suite').summary.skipped,1);
 commands[0].args.pop();save();assert.equal(expect(1,'configuration drift is refused').configDrift,true);pin([]);
 assert.equal(expect(1,'removed canonical flag reveals nested suite').summary.nested,1);
 const caller="import './suite-helper.mjs';";
 fs.writeFileSync(path.join(root,'a.mjs'),caller);fs.writeFileSync(path.join(root,'suite-helper.mjs'),"import {spawn} from 'node:child_process';spawn(process.execPath,['b.mjs']);");
 const row=expect(1,'new helper edge requires review').rows[0];
 const exception={id:'reviewed-property',key:row.key,callDigest:row.callDigest,sourceDigest:row.sourceDigest,configIndexes:[0],kind:'property',reason:'Synthetic fixture tests exact reviewed exception binding.',requiredEvidence:['Synthetic paired artifact property'],dependencyDigests:{'a.mjs':hash(caller),'suite-helper.mjs':hash(fs.readFileSync(path.join(root,'suite-helper.mjs')))}};
 pin([exception]);expect(0,'exact reviewed exception accepted');
 const noDeps={...exception};delete noDeps.dependencyDigests;pin([noDeps]);expect(1,'missing dependency set refused');
 pin([{...exception,dependencyDigests:{}}]);expect(1,'empty dependency set refused');
 pin([{...exception,dependencyDigests:{'suite-helper.mjs':exception.dependencyDigests['suite-helper.mjs']}}]);expect(1,'omitted caller dependency refused');
 pin([exception]);fs.appendFileSync(path.join(root,'a.mjs'),'\n// caller changed');expect(1,'caller drift invalidates unchanged helper exception');
 fs.writeFileSync(path.join(root,'a.mjs'),caller);fs.appendFileSync(path.join(root,'suite-helper.mjs'),'\n// helper changed');
 assert.deepEqual(expect(1,'source drift invalidates exception').staleExceptions,['reviewed-property']);
 // Exact native helper closure of the configured quorum entry. These files are
 // parsed by the scanner; their child processes are never executed by this test.
 const tasks='packages/main/src/tasks/',quorumEntry='packages/main/dist/tasks/quorum-submit-smoke.js';
 const graph={
  'quorum-submit-smoke.ts':['quorum-submit-smoke-case-catalog','quorum-submit-smoke-pure-cases','quorum-submit-smoke-integration-cases','quorum-submit-smoke-prune-cases','quorum-submit-smoke-worker'],
  'quorum-submit-smoke-pure-cases.ts':['quorum-submit-smoke-case-catalog','quorum-submit-smoke-integration-cases'],
  'quorum-submit-smoke-prune-cases.ts':['quorum-submit-smoke-case-catalog','quorum-submit-smoke-integration-cases'],
  'quorum-submit-smoke-integration-cases.ts':['native-certification-fixture','native-review-fixture','quorum-submit-smoke-case-catalog','quorum-submit-smoke-fixture'],
  'quorum-submit-smoke-worker.ts':['quorum-submit-smoke-case-catalog','quorum-submit-smoke-fixture'],
  'quorum-submit-smoke-fixture.ts':['quorum-submit-smoke-case-catalog'],
  'quorum-submit-smoke-case-catalog.ts':[],
  'native-certification-fixture.ts':['native-review-fixture','fixture-environment'],
  'native-review-fixture.ts':['fixture-environment'],'fixture-environment.ts':[],
 };
 const writeHelper=(name,text)=>fs.writeFileSync(path.join(root,tasks,name),text);
 const writeGraph=(reverse=false)=>{
  fs.mkdirSync(path.join(root,tasks),{recursive:true});
  for(const [name,imports]of Object.entries(graph))writeHelper(name,(reverse&&name==='quorum-submit-smoke-integration-cases.ts'?[...imports].reverse():imports).map(helper=>`import './${helper}.js';`).join('\n'));
  commands[0]={command:'node',args:[quorumEntry]};save();pin([]);
 };
 writeGraph();writeHelper('quorum-submit-smoke-integration-cases.ts',graph['quorum-submit-smoke-integration-cases.ts'].filter(name=>name!=='native-certification-fixture').map(name=>`import './${name}.js';`).join('\n'));
 const legacyReport=expect(0,'existing main quorum graph without optional native certification helper succeeds');
 assert.equal(legacyReport.summary.unexpandedCommands,0);assert.equal(legacyReport.summary.needsReview,0);
 writeGraph();
 const nativeReport=expect(0,'native closure process succeeds with current configuration and no stale exception');
 assert.equal(nativeReport.summary.unexpandedCommands,0,'U18_NATIVE_FIXTURE_CLOSURE_UNEXPANDED '+JSON.stringify(nativeReport.coverage.filter(row=>row.state==='NEEDS_REVIEW')));
 assert.equal(nativeReport.summary.needsReview,0);assert.equal(nativeReport.summary.nested,0);
 for(const name of ['native-certification-fixture.ts','native-review-fixture.ts','fixture-environment.ts'])assert(nativeReport.coverage.some(row=>row.index===0&&row.file===tasks+name&&row.state==='SCANNED'),`native closure not traversed: ${name}`);
 console.log('PASS exact quorum native helper closure');
 writeGraph(true);expect(0,'native helper closure preserves reversed import order');
 writeGraph();writeHelper('fixture-environment.ts',"import {spawn} from 'node:child_process';spawn(process.execPath,['b.mjs']);");
 assert(expect(1,'deep native fixture child still requires review').summary.nested>0);
 writeGraph();fs.appendFileSync(path.join(root,tasks,'native-certification-fixture.ts'),"\nimport './unknown-helper.js';");writeHelper('unknown-helper.ts','');
 assert(expect(1,'unregistered helper depth remains bounded').coverage.some(row=>row.file===tasks+'unknown-helper.ts'&&row.reason==='helper depth exceeds declared bound'));
 writeGraph();fs.appendFileSync(path.join(root,tasks,'quorum-submit-smoke-worker.ts'),"\nimport './native-certification-fixture.js';");
 assert(expect(1,'optional native helper remains confined to integration caller').coverage.some(row=>row.file===tasks+'quorum-submit-smoke-worker.ts'&&row.reason==='Registered verifier imported helper changed or is not a literal'));
 writeGraph();fs.appendFileSync(path.join(root,tasks,'quorum-submit-smoke-integration-cases.ts'),"\nimport './stray-helper.js';");writeHelper('stray-helper.ts','');
 assert(expect(1,'unregistered literal helper in registered integration remains refused').coverage.some(row=>row.file===tasks+'quorum-submit-smoke-integration-cases.ts'&&row.reason==='Registered verifier imported helper changed or is not a literal'));
 writeGraph();fs.appendFileSync(path.join(root,tasks,'quorum-submit-smoke-integration-cases.ts'),"\nimport('./' + 'native-certification-fixture.js');");
 assert(expect(1,'computed registered helper remains refused').coverage.some(row=>row.reason==='Registered verifier imported helper changed or is not a literal'));
 writeGraph();writeHelper('quorum-submit-smoke-integration-cases.ts',graph['quorum-submit-smoke-integration-cases.ts'].filter(name=>name!=='native-review-fixture').map(name=>`import './${name}.js';`).join('\n'));
 assert(expect(1,'missing original required native import remains refused').coverage.some(row=>row.file===tasks+'quorum-submit-smoke-integration-cases.ts'&&row.reason==='Registered verifier required helper import missing'&&row.expected==='./native-review-fixture.js'));
 writeGraph();fs.unlinkSync(path.join(root,tasks,'native-certification-fixture.ts'));
 assert(expect(1,'missing registered native helper remains refused').coverage.some(row=>row.reason==='source missing'));
 writeGraph();fs.writeFileSync(path.join(root,'other-suite.mjs'),`import './${tasks}quorum-submit-smoke-integration-cases.js';`);commands[0]={command:'node',args:['other-suite.mjs']};save();pin([]);
 assert(expect(1,'native depth extension is confined to exact quorum entry').coverage.some(row=>row.file===tasks+'fixture-environment.ts'&&row.reason==='helper depth exceeds declared bound'));
 writeGraph();const brandEntry='packages/main/tests/brand-role-migration.test.mjs';
 fs.mkdirSync(path.dirname(path.join(root,brandEntry)),{recursive:true});fs.writeFileSync(path.join(root,brandEntry),'');
 commands[0]={command:'node',args:[brandEntry]};save();pin([]);
 const brandReport=expect(1,'brand-role named entry preserves source pin while traversing generic depths one and two');
 assert.deepEqual(brandReport.coverage.filter(row=>row.state==='NEEDS_REVIEW').map(row=>row.reason),['Reviewed nested witness source changed']);
 for(const name of ['native-review-fixture.ts','fixture-environment.ts'])assert(brandReport.coverage.some(row=>row.file===tasks+name&&row.state==='SCANNED'));
 writeHelper('fixture-environment.ts',"import './brand-depth-three.js';");writeHelper('brand-depth-three.ts',"import './brand-depth-four.js';");writeHelper('brand-depth-four.ts','');
 assert(expect(1,'brand-role entry retains generic depth-four refusal').coverage.some(row=>row.file===tasks+'brand-depth-four.ts'&&row.reason==='helper depth exceeds declared bound'));
 console.log('U18_STATIC_EDGE_BOUNDARIES_PASS');
}finally{fs.rmSync(root,{recursive:true,force:true});}
