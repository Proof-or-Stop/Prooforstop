import {LAB_VERSION_FIXTURE_TOTAL_TIMEOUT_MS,STATIC_EVIDENCE_LIVE_SCAN_TIMEOUT_MS,assertLabRegressionTransport} from './lab-version-fixture-transport.mjs';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import assert from 'node:assert/strict';import crypto from 'node:crypto';import {createRequire} from 'node:module';import {spawnSync} from 'node:child_process';import {fileURLToPath} from 'node:url';
const repo=fileURLToPath(new URL('..',import.meta.url)),root=fs.mkdtempSync(path.join(os.tmpdir(),'u18-static-boundaries-'));

// Real repository target; unrelated historical scanner debt is compared, not hidden.
function verifyRuntimeSnapshotStaticEdge() {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-snapshot-static-'));
  try {
    const inventoryPath = path.join(repo, 'scripts/lab/u18-static-edges/exceptions.json');
    const inventory = JSON.parse(fs.readFileSync(inventoryPath, 'utf8'));
    const caller = 'scripts/verify-runtime-fact-contract.mjs';
    const target = 'scripts/verify-validation-snapshot-binding.mjs';
    const readInput = 'packages/main/src/core/shared-validation-execution.ts';
    const targetExpression = "execFileSync(process.execPath, [join(root, 'scripts/verify-validation-snapshot-binding.mjs')],\n    { cwd: root, stdio: 'inherit', timeout: 30000 })";
    const digest = text => crypto.createHash('sha256').update(text).digest('hex');
    const matches = report => report.rows.filter(row => row.file === caller && row.expression === targetExpression);
    const scan = (value, label) => {
      const manifestPath = path.join(scratch, label + '.json');
      const reportPath = path.join(scratch, label + '-report.json');
      fs.writeFileSync(manifestPath, JSON.stringify(value));
      const result = spawnSync(process.execPath, [path.join(repo, 'scripts/verify-validation-static-edges.mjs'), repo, manifestPath], {
        encoding: 'utf8', timeout: 30000, maxBuffer: 32 * 1024 * 1024,
        env: { ...process.env, U18_STATIC_REPORT_PATH: reportPath },
      });
      assert.equal(result.error, undefined, label + ' scanner setup');
      assert.equal(result.signal, null, label + ' scanner interrupted');
      assert.ok([0, 1].includes(result.status), label + ' scanner exited unexpectedly');
      return JSON.parse(fs.readFileSync(reportPath, 'utf8'));
    };
    const current = scan(inventory, 'current');
    const rows = matches(current);
    assert.equal(rows.length, 1, 'exact current runtime snapshot launcher must be observed once');
    assert.equal(rows[0].state, 'EXCEPTION', 'RUNTIME_SNAPSHOT_STATIC_EDGE_UNREVIEWED: current canonical scanner must recognize the exact reviewed child');
    const entries = inventory.entries.filter(entry => entry.key === rows[0].key && entry.callDigest === rows[0].callDigest);
    assert.equal(entries.length, 1, 'one exact reviewed edge');
    const entry = entries[0];
    assert.deepEqual(Object.keys(entry.dependencyDigests).sort(), [caller, target, readInput].sort());
    for (const file of [caller, target, readInput]) {
      assert.equal(entry.dependencyDigests[file], digest(fs.readFileSync(path.join(repo, file))));
    }
    assert.deepEqual(entry.invocations, [{ entry: caller, argv: [] }]);
    assert.deepEqual(entry.configIndexes, [rows[0].index]);
    const without = structuredClone(inventory);
    without.entries = without.entries.filter(value => value.id !== entry.id);
    const missing = scan(without, 'missing');
    assert.equal(matches(missing)[0].state, 'NEEDS_REVIEW', 'entry removal must expose exact unresolved edge');
    const otherRows = report => report.rows.filter(row => !(row.file === caller && row.expression === targetExpression));
    assert.deepEqual(otherRows(current), otherRows(missing), 'unrelated scanner row behavior must remain unchanged');
    assert.deepEqual(current.coverage, missing.coverage);
    assert.deepEqual(current.staleExceptions, missing.staleExceptions);
    assert.equal(current.configDrift, missing.configDrift);
    for (const file of [caller, target, readInput]) {
      const altered = structuredClone(inventory);
      altered.entries.find(value => value.id === entry.id).dependencyDigests[file] = '0'.repeat(64);
      const changed = scan(altered, 'drift-' + file.replaceAll('/', '-'));
      assert.equal(matches(changed)[0].state, 'NEEDS_REVIEW', 'dependency drift must refuse: ' + file);
      assert.equal(matches(changed)[0].reason, file === caller
        ? 'exception dependency coverage missing or changed' : 'incomplete exception');
    }
    const wrongInvocation = structuredClone(inventory);
    wrongInvocation.entries.find(value => value.id === entry.id).configIndexes = [rows[0].index + 10000];
    assert.equal(matches(scan(wrongInvocation, 'wrong-invocation'))[0].state, 'NEEDS_REVIEW');
    console.log('RUNTIME_SNAPSHOT_STATIC_EDGE_GREEN exact edge and dependency refusals; unrelated baseline preserved');
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}
if (process.argv.includes('--runtime-snapshot-edge')) {
  verifyRuntimeSnapshotStaticEdge();
  fs.rmSync(root, { recursive: true, force: true });
  process.exit(0);
}

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
 const exception={id:'reviewed-property',key:row.key,callDigest:row.callDigest,sourceDigest:row.sourceDigest,configIndexes:[0],kind:'property',reason:'Synthetic fixture tests exact reviewed exception binding.',requiredEvidence:[{file:'suite-helper.mjs',startLine:1,endLine:1,sourceDigest:row.sourceDigest,excerpt:fs.readFileSync(path.join(root,'suite-helper.mjs'),'utf8')}],dependencyDigests:{'a.mjs':hash(caller),'suite-helper.mjs':hash(fs.readFileSync(path.join(root,'suite-helper.mjs')))}};
 pin([exception]);expect(0,'exact reviewed exception accepted');
 const evidence = exception.requiredEvidence[0];
 const rejectEvidence = (requiredEvidence, label, reason) => {
  pin([{...exception,requiredEvidence}]);
  const report = expect(1, 'SOURCE_EVIDENCE_CONTRACT: '+label);
  assert.equal(report.rows.find(row=>row.key===exception.key)?.reason,reason,label);
 };
 const stale='source evidence digest is stale', mismatch='source evidence excerpt does not match its lines';
 const bounds='source evidence invalid: source evidence line bounds are invalid';
 const noCurrent='source evidence has no structured current-source entry';
 rejectEvidence([{...evidence,sourceDigest:'0'.repeat(64)}], 'stale nested digest',stale);
 rejectEvidence([{...evidence,file:'nonexistent-evidence.mjs'}], 'missing evidence file has stable refusal','source evidence file is missing');
 rejectEvidence([{...evidence,excerpt:evidence.excerpt+' // invented'}], 'tampered excerpt',mismatch);
 rejectEvidence([{...evidence,startLine:2,endLine:2}], 'range beyond source length',bounds);
 rejectEvidence([{...evidence,startLine:0}], 'invalid line bounds',bounds);
 const outside=path.join(root+'-outside.mjs');fs.writeFileSync(outside,evidence.excerpt);
 try {
  rejectEvidence([{...evidence,file:'../'+path.basename(outside)}], 'escaping relative source path',
   'source evidence invalid: source evidence file must be a normalized repository-relative path');
  fs.symlinkSync(outside,path.join(root,'linked-helper.mjs'));
  rejectEvidence([{...evidence,file:'linked-helper.mjs'}], 'existing symlink target outside repository',
   'source evidence invalid: source evidence file escapes the repository');
 } finally {fs.rmSync(outside,{force:true});}
 rejectEvidence(['Historical review narrative'], 'narrative alone is not current source evidence',noCurrent);
 rejectEvidence([{...evidence,historical:true}], 'historical source alone cannot authorize current exception',noCurrent);
 rejectEvidence([evidence,{...evidence,sourceDigest:'0'.repeat(64)}], 'covering evidence cannot launder stale sibling',stale);
 rejectEvidence([evidence,{...evidence,excerpt:'invented'}], 'covering evidence cannot launder altered sibling',mismatch);
 rejectEvidence([null], 'null evidence rejected','source evidence malformed');
 rejectEvidence([[evidence]], 'nested arrays rejected','source evidence malformed');
 rejectEvidence([{...evidence,historical:'true'}], 'string historical flag rejected','source evidence historical flag malformed');
 fs.writeFileSync(path.join(root,'context.mjs'),'// current context');
 rejectEvidence([{file:'context.mjs',startLine:1,endLine:1,sourceDigest:hash('// current context'),excerpt:'// current context'}], 'current context does not cover actual call','source evidence does not cover the current callsite');
 pin([exception]);expect(0,'coherent source evidence remains accepted after negative controls');
 const {createStaticSourceEvidence} = await import('./static-source-evidence.mjs');
 assert.deepEqual(createStaticSourceEvidence(root,'suite-helper.mjs',1,1), evidence);
 assert.throws(()=>createStaticSourceEvidence(root,'suite-helper.mjs',0,1), /line bounds/);
 const contextualSource = '// context only\n'+evidence.excerpt;
 fs.writeFileSync(path.join(root,'suite-helper.mjs'),contextualSource);
 const moved = {...exception,key:exception.key.replace(':1:',':2:'),sourceDigest:hash(contextualSource),
  dependencyDigests:{...exception.dependencyDigests,'suite-helper.mjs':hash(contextualSource)}};
 pin([{...moved,requiredEvidence:[createStaticSourceEvidence(root,'suite-helper.mjs',1,1)]}]);
 assert.equal(expect(1,'current valid excerpt outside moved callsite refused').rows.find(row=>row.key===moved.key)?.reason,'source evidence does not cover the current callsite');
 pin([{...moved,requiredEvidence:[createStaticSourceEvidence(root,'suite-helper.mjs',1,2), {...evidence,historical:true}, 'Historical context only']}]);
 assert.equal(expect(0,'single snapshot refresh covers moved call; history remains supplemental').rows.find(row=>row.key===moved.key)?.state,'EXCEPTION');
 const invalidUtf8=Buffer.concat([Buffer.from('// '),Buffer.from([0xff]),Buffer.from('\n'+evidence.excerpt)]);
 fs.writeFileSync(path.join(root,'suite-helper.mjs'),invalidUtf8);
 const byteEvidence=createStaticSourceEvidence(root,'suite-helper.mjs',1,2);
 assert.equal(byteEvidence.sourceDigest,hash(invalidUtf8),'source digest hashes original bytes before UTF-8 decoding');
 pin([{...moved,sourceDigest:hash(invalidUtf8),dependencyDigests:{...moved.dependencyDigests,'suite-helper.mjs':hash(invalidUtf8)},requiredEvidence:[byteEvidence]}]);
 assert.equal(expect(0,'invalid UTF-8 comment retains consistent byte digests').rows.find(row=>row.key===moved.key)?.state,'EXCEPTION');
 fs.writeFileSync(path.join(root,'suite-helper.mjs'),evidence.excerpt);


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
 // The closed native regression route must bind resource policy and URL-loaded APIs
 // directly. A fresh global configDigest alone is not direct dependency evidence.
 {
  const entry='scripts/verify-nested-reservation-registered.mjs';
  const graph={
   'scripts/verify-nested-reservation-cancellation.mjs':['./support/nested-reservation-source-runtime.mjs'],
   'scripts/verify-nested-reservation-boot-recovery.mjs':['./support/nested-reservation-source-runtime.mjs'],
   'scripts/verify-nested-validation-result-contract.mjs':['./support/nested-reservation-source-runtime.mjs'],
   [entry]:['./verify-nested-isolated-cleanup.mjs','./verify-nested-isolated-worker-exit.mjs','./verify-nested-reservation-cleanup-diagnostics.mjs','./verify-nested-reservation-faults.mjs','./verify-nested-reservation-handshake-deadline.mjs','./verify-nested-reservation-owner-loss.mjs','./verify-nested-reservation-registration-race.mjs','./verify-nested-source-loader-semantics.mjs','./verify-nested-verification-machine-owner.mjs','./verify-nested-validation-result-contract.mjs','./verify-nested-reservation-cancellation.mjs','./verify-nested-reservation-boot-recovery.mjs'],
   'scripts/verify-nested-verification-machine-owner.mjs':['./support/nested-reservation-lifecycle.mjs','./lab-source-loader.mjs','../packages/main/src/core/validation-executor.ts'],
   ...Object.fromEntries(['isolated-worker-exit','isolated-cleanup','reservation-cleanup-diagnostics','reservation-registration-race','reservation-owner-loss','reservation-faults'].map(name=>['scripts/verify-nested-'+name+'.mjs',['./support/nested-reservation-source-runtime.mjs']]))
  };
  const policyInputs=['proof-or-stop.config.json','packages/main/src/core/runtime-fact-registry.ts','packages/main/src/core/validation-reservation-delegation.ts','packages/main/src/core/validation-execution-lock.ts','packages/main/src/core/validation-executor.ts','packages/main/src/tasks/isolated-finding-fixture.ts','scripts/support/nested-reservation-source-runtime.mjs','scripts/support/nested-reservation-lifecycle.mjs'];
  const put=(file,text)=>{fs.mkdirSync(path.dirname(path.join(root,file)),{recursive:true});fs.writeFileSync(path.join(root,file),text);};
  for(const file of policyInputs)put(file,'// Synthetic scanner input; never executed.\n');
  const inputs=new Set(policyInputs);
  for(const [file,imports]of Object.entries(graph)){
   inputs.add(file);put(file,imports.map(spec=>'await import('+JSON.stringify(spec)+');').join('\n'));
   for(const spec of imports){const leaf=path.posix.normalize(path.posix.join(path.posix.dirname(file),spec));inputs.add(leaf);if(!fs.existsSync(path.join(root,leaf)))put(leaf,'');}
  }
  const callFile='scripts/support/nested-reservation-lifecycle.mjs';
  const call="spawnSync(process.execPath, ['-e', ''], { timeout: 1000 })";
  const text="import { spawnSync } from 'node:child_process';\n"+call+';\n';put(callFile,text);
  commands.splice(0,commands.length,{command:'node',args:[entry,'core'],timeoutMs:60000,resources:[{type:'machine-cpu',key:'heavy',access:'exclusive'}]});save();
  const exact={id:'EX-NESTED-BINDING-TEST',key:callFile+':2:spawnSync',callDigest:hash(call),sourceDigest:hash(text),configIndexes:[0],kind:'INLINE_PROCESS_PROBE',reason:'Synthetic scanner-only source fixture; never executed.',requiredEvidence:[{file:callFile,startLine:1,endLine:2,sourceDigest:hash(text),excerpt:text.trimEnd()}],dependencyDigests:Object.fromEntries([...inputs].map(file=>[file,hash(fs.readFileSync(path.join(root,file)))]))};
  pin([exact]);const complete=expect(0,'native route exact direct policy and API dependencies');
  assert.equal(complete.configDrift,false);assert.equal(complete.rows.length,1);assert.equal(complete.rows[0].state,'EXCEPTION');
  for(const file of ['proof-or-stop.config.json','packages/main/src/core/validation-reservation-delegation.ts']){
   const missing=structuredClone(exact);delete missing.dependencyDigests[file];pin([missing]);
   const missingReport=expect(1,'native route missing direct dependency '+file);
   assert.equal(missingReport.configDrift,false,'global config remains fresh in the missing direct-binding control');
   assert.equal(missingReport.rows[0].reason,'exception dependency coverage missing or changed');
   const changed=structuredClone(exact);changed.dependencyDigests[file]='0'.repeat(64);pin([changed]);
   assert.equal(expect(1,'native route wrong direct dependency '+file).rows[0].state,'NEEDS_REVIEW');
  }
  const wrongExcerpt=structuredClone(exact);wrongExcerpt.requiredEvidence[0].excerpt+=' altered';pin([wrongExcerpt]);
  assert.equal(expect(1,'native route exact source excerpt remains mandatory').rows[0].state,'NEEDS_REVIEW');
  pin([exact]);expect(0,'native route complete binding restored');
 }
 const releaseStarted=performance.now();
 const releaseCase=spawnSync(process.execPath,[path.join(repo,'scripts/verify-lab-version-source-evidence.mjs')],{encoding:'utf8',timeout:LAB_VERSION_FIXTURE_TOTAL_TIMEOUT_MS,maxBuffer:32*1024*1024});
 console.log('STATIC_EVIDENCE_CHILD_TIMING '+JSON.stringify({label:'version-release-contract',elapsedMs:performance.now()-releaseStarted,budgetMs:LAB_VERSION_FIXTURE_TOTAL_TIMEOUT_MS,status:releaseCase.status,signal:releaseCase.signal}));
 assertLabRegressionTransport(releaseCase,'version-release-contract',LAB_VERSION_FIXTURE_TOTAL_TIMEOUT_MS);
 assert.equal(releaseCase.status,0,'LAB_VERSION_MUST_REFRESH_CURRENT_SOURCE_EVIDENCE '+releaseCase.stdout+releaseCase.stderr);
 console.log(releaseCase.stdout.trim());
 const {staticSourceEvidenceError} = await import('./static-source-evidence.mjs');
 const liveManifest=JSON.parse(fs.readFileSync(path.join(repo,'scripts/lab/u18-static-edges/exceptions.json'),'utf8'));
 for(const entry of liveManifest.entries){
  const match=entry.key.match(/^(.*):(\d+):[^:]+$/);assert(match,'manifest key must identify its source callsite');
  assert.equal(entry.sourceDigest,hash(fs.readFileSync(path.join(repo,match[1]))),entry.id+' current source digest');
  const deps=entry.dependencyDigests;assert(deps&&typeof deps==='object'&&!Array.isArray(deps)&&Object.keys(deps).length>0,entry.id+' must bind a non-empty dependency set');
  for(const [file,digest] of Object.entries(deps))assert.equal(digest,hash(fs.readFileSync(path.join(repo,file))),entry.id+' dependency '+file);
  assert.equal(staticSourceEvidenceError(repo,entry.requiredEvidence,{file:match[1],line:Number(match[2])}),null,entry.id+' current manifest evidence');
 }
 console.log('PASS all '+liveManifest.entries.length+' committed manifest entries have current covering source evidence');
 const liveStarted=performance.now();
 const liveScan=spawnSync(process.execPath,[path.join(repo,'scripts/verify-validation-static-edges.mjs'),repo],{encoding:'utf8',timeout:STATIC_EVIDENCE_LIVE_SCAN_TIMEOUT_MS,maxBuffer:32*1024*1024});
 console.log('STATIC_EVIDENCE_CHILD_TIMING '+JSON.stringify({label:'live-static-scan',elapsedMs:performance.now()-liveStarted,budgetMs:STATIC_EVIDENCE_LIVE_SCAN_TIMEOUT_MS,status:liveScan.status,signal:liveScan.signal}));
 assertLabRegressionTransport(liveScan,'live-static-scan',STATIC_EVIDENCE_LIVE_SCAN_TIMEOUT_MS);
 assert.equal(liveScan.status,0,'Current repository static scanner must pass: '+liveScan.stdout+liveScan.stderr);
 console.log(liveScan.stdout.trim());
 console.log('U18_STATIC_EDGE_BOUNDARIES_PASS');
}finally{fs.rmSync(root,{recursive:true,force:true});}

verifyRuntimeSnapshotStaticEdge();
