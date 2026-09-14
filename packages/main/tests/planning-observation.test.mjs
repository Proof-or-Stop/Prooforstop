import assert from 'node:assert/strict';
import ts from 'typescript';
import fs from 'node:fs';import path from 'node:path';import {syncBuiltinESMExports} from 'node:module';
import {captureVerificationFreshness,prepareVerificationExecutionIdentity,withVerificationPlanningObservation,withVerificationRefreshObservation} from '../dist/core/verification-execution-evidence.js';
const original=fs.readFileSync,anchor=path.resolve('packages/main/dist/core/execution-implementation.js');let scans=0,revision=0;
fs.readFileSync=function(file,...rest){let value=original.call(this,file,...rest);if(String(file)===anchor){scans++;if(revision)value=Buffer.isBuffer(value)?Buffer.concat([value,Buffer.from('\n// observed revision '+revision)]):value+'\n// observed revision '+revision;}return value;};syncBuiltinESMExports();
const input={command:'node --version',cwd:process.cwd(),effectiveTimeoutMs:2000};
const observe=()=>prepareVerificationExecutionIdentity(input);
try {
 for (const scope of [withVerificationPlanningObservation, withVerificationRefreshObservation]) {
 const first=observe();scans=0;
 const grouped=scope(()=>[observe(),observe(),observe()]);assert.equal(scans,1,'three planning rows share one implementation scan');
 assert.ok(grouped.every(row=>row.executionIdentityDigest===first.executionIdentityDigest),'grouping preserves command identity');
 scans=0;const varied=scope(()=>[observe(),prepareVerificationExecutionIdentity({...input,effectiveTimeoutMs:3000})]);assert.equal(scans,1);assert.notEqual(varied[0].executionIdentityDigest,varied[1].executionIdentityDigest,'per-row timeout remains independent');
 scans=0;observe();observe();assert.equal(scans,2,'independent observations rescan');
 let before;assert.throws(()=>scope(()=>{before=observe();throw Error('abort');}),/abort/);revision++;
 assert.notEqual(observe().toolchainDigest,before.toolchainDigest,'throw releases observation');
 await scope(async()=>{const before=observe();await Promise.resolve();revision++;assert.notEqual(observe().toolchainDigest,before.toolchainDigest,'no cached implementation crosses await');});
 scans=0;scope(()=>{observe();scope(()=>observe());observe();});assert.equal(scans,2,'nested planning observations are independent and restore outer scope');
 }
 console.log('PLANNING_OBSERVATION_BOUNDARIES PASS reuse, fresh calls, throwing scope, await, nested scope');
}finally{fs.readFileSync=original;syncBuiltinESMExports();}

// Guard the actual refresh call sites against broadening across async/commit boundaries.
const source=fs.readFileSync('packages/main/src/handlers/checklist.ts','utf8');
const ast=ts.createSourceFile('checklist.ts',source,ts.ScriptTarget.Latest,true);
const scopes=[];
function walk(n){if(ts.isCallExpression(n)&&n.expression.getText(ast)==='withVerificationRefreshObservation')scopes.push(n);ts.forEachChild(n,walk);}walk(ast);
assert.equal(scopes.length,3,'exactly three bounded refresh observations');
for(const call of scopes){const callback=call.arguments[0];assert.ok(ts.isArrowFunction(callback));assert.ok(!callback.modifiers?.some(m=>m.kind===ts.SyntaxKind.AsyncKeyword));
 const check=n=>{assert.notEqual(n.kind,ts.SyntaxKind.AwaitExpression,'refresh scope cannot contain await');if(ts.isCallExpression(n))assert.ok(!/commitCanonicalCausalEvidence|withVerificationExecutionLocks|enforceAndStampEvidence/.test(n.expression.getText(ast)),'execution, lock acquisition and publication must remain outside observation');ts.forEachChild(n,check);};check(callback.body);
}
assert.equal(scopes.filter(n=>n.getText(ast).includes('buildVerificationCoverage(')).length,1);
assert.equal(scopes.filter(n=>n.getText(ast).includes('for (const entry of stale)')).length,1);
assert.equal(scopes.filter(n=>n.getText(ast).includes('for (const entry of computed.stale)')).length,1);
console.log('REFRESH_OBSERVATION_BOUNDARIES PASS three synchronous scopes, independent timeout, no execution or publication inside');

// Execute the actual compiled recovery closure with controlled collaborators.
// These are orchestration boundary tests, not native execution receipts.
const compiled=fs.readFileSync('packages/main/dist/handlers/checklist.js','utf8');
const compiledAst=ts.createSourceFile('checklist.js',compiled,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);
let recoveryExpression;
function findRecovery(n){if(ts.isVariableDeclaration(n)&&n.name.getText(compiledAst)==='enforceWithPublicationRecovery')recoveryExpression=n.initializer.getText(compiledAst);ts.forEachChild(n,findRecovery);}findRecovery(compiledAst);
assert.ok(recoveryExpression);
const recoveryDependencies=['verificationProducerPlan','enforceAndStampEvidence','captureVerificationFreshness','causalDigest','store','readOwnerLease','root','executionImplementationIdentity','isSplitVerificationReceipt','executionMatchesPlan','validateVerificationReceipt','createCausalPublicationRecovery'];
let implementation='implementation-A',plan,request,executionReads=[],pending,failPlan=false,drift=false,directReads=0;
const recovery=new Function(...recoveryDependencies,'return ('+recoveryExpression+');')(
 ()=>{plan=failPlan?undefined:{executionKey:'execution-'+implementation,preparedIdentity:{implementationDigest:implementation}};return plan;},
 async(_item,_input,deps)=>{executionReads.push({implementation,shared:deps.sharedExecutionReceipt,plan:deps.plan});await Promise.resolve();return {evidencePatch:{result:'fail'}};},
 ()=>{if(drift)implementation='implementation-B';return {};},
 value=>{request=value;return JSON.stringify(value);},
 {readChecklist:()=>({items:[]}),storyDirPath:()=>'.',readPendingPublication:()=>pending},
 ()=>({leaseId:'lease'}),process.cwd(),()=>{directReads++;return {digest:implementation};},
 ()=>false,()=>false,()=>({ok:false}),()=>{throw Error('failure must not create recovery authority');}
);
const recoveryArgs=[{id:'item'},{intentRef:'intent'},{cwd:process.cwd(),storyId:'story'}];
await recovery(...recoveryArgs);assert.equal(request.implementationDigest,plan.preparedIdentity.implementationDigest);assert.equal(directReads,0,'request key consumes its plan observation');
drift=true;await recovery(...recoveryArgs);assert.equal(request.implementationDigest,'implementation-A','request binds the same snapshot as executionKey');assert.equal(executionReads.at(-1).implementation,'implementation-B','execution independently observes intervening mutation');
drift=false;await recovery(...recoveryArgs);assert.equal(request.implementationDigest,'implementation-B','next recovery call obtains a fresh plan');
pending={publication:{receipt:{}}};const count=executionReads.length;await assert.rejects(recovery(...recoveryArgs),/publication_recovery_invalid/);assert.equal(executionReads.length,count,'invalid pending receipt cannot reach execution');
pending=undefined;failPlan=true;await recovery(...recoveryArgs);assert.equal(executionReads.length,count+1,'no-plan fallback still delegates');
console.log('RECOVERY_REQUEST_OBSERVATION_BOUNDARIES PASS snapshot coherence, intervening drift reaches execution, fresh next call, invalid pending refusal, fallback');
let sharedGuard;
function findSharedGuard(n){if(ts.isIfStatement(n)&&n.thenStatement.getText(compiledAst).includes('[verification_shared_execution_identity_mismatch]'))sharedGuard=n.getText(compiledAst);ts.forEachChild(n,findSharedGuard);}findSharedGuard(compiledAst);
assert.ok(sharedGuard);
const checkShared=new Function('sharedExecution','pinCommand','deps','effectiveTimeoutMs','sharedIdentity',sharedGuard);
const currentReceipt={command:'node --version',cwd:process.cwd(),effectiveTimeoutMs:2000,executionIdentityDigest:'current'};
const checkReceipt=receipt=>checkShared(receipt,'node --version',{cwd:process.cwd()},2000,{executionIdentityDigest:'current'});
assert.doesNotThrow(()=>checkReceipt(currentReceipt));
for(const patch of [{executionIdentityDigest:'old'},{command:'node different.js'},{cwd:'/different'},{effectiveTimeoutMs:1000}])assert.throws(()=>checkReceipt({...currentReceipt,...patch}),/verification_shared_execution_identity_mismatch/);
console.log('RECOVERY_SHARED_RECEIPT_GUARD PASS actual compiled guard rejects stale identity, command, cwd and unauthorized timeout');

const fourDefects=[];
// A supplied internal batch plan must not trigger a second producer plan.
failPlan=false;pending=undefined;drift=false;implementation='current-producer';
const suppliedPlan={executionKey:'supplied-key',preparedIdentity:{implementationDigest:'supplied-implementation'}};
await recovery(...recoveryArgs,{plan:suppliedPlan});
if(request.executionKey!==suppliedPlan.executionKey||request.implementationDigest!==suppliedPlan.preparedIdentity.implementationDigest)fourDefects.push('duplicate-batch-plan');
// Evaluate the actual preflight assignments with two distinct observations.
let enforceBody;
function findEnforce(n){if(ts.isFunctionDeclaration(n)&&n.name?.text==='enforceAndStampEvidence')enforceBody=n.body;ts.forEachChild(n,findEnforce);}findEnforce(compiledAst);
const preflightAssignments=enforceBody.statements.filter(n=>ts.isVariableStatement(n)&&n.declarationList.declarations.some(d=>['hashes','launchFreshness'].includes(d.name.getText(compiledAst))));assert.equal(preflightAssignments.length,2);
const preflight=new Function('evidenceHashes','captureVerificationFreshness','deps',preflightAssignments.map(n=>n.getText(compiledAst)).join('\n')+'\nreturn {hashes,launchFreshness};');
let observations=0;const pair=preflight(()=>{observations++;return {headHash:'old'};},()=>{observations++;return {headHash:'current'};},{cwd:'.',metadataRoot:'.'});
if(observations!==1||pair.hashes!==pair.launchFreshness)fourDefects.push('duplicate-preflight-freshness');
assert.throws(()=>preflight(()=>({}),()=>{throw Error('strict freshness unavailable');},{cwd:'.',metadataRoot:'.'}),/strict freshness unavailable/);
const {checkImplementationReadObservation}=await import('./implementation-read-observation.test.mjs');const readResult=checkImplementationReadObservation();if(readResult.duplicateReads!==0)fourDefects.push('duplicate-file-reads');
console.log('FOUR_BOUNDARY_RESULTS '+JSON.stringify({fourDefects,preflightObservations:observations,...readResult}));
assert.deepEqual(fourDefects,[],'FOUR_BOUNDARIES_RED: duplicate observations remain');
console.log('FOUR_BOUNDARIES_GREEN full scope retained, no same-scan rereads, current batch plan, one strict preflight observation');

// Current Git state is observed once per synchronous refresh scope.
const cp=(await import('node:child_process')).default;const {mkdtempSync,rmSync,writeFileSync}=await import('node:fs');const {tmpdir}=await import('node:os');
const {currentGitHead,currentMaterialHash,currentStoryFilesHash,checkEvidenceFreshnessForGit,checkStrictVerificationEvidenceFreshnessForGit}=await import('../dist/core/evidence-freshness.js');
const repo=mkdtempSync(path.join(tmpdir(),'git-state-observation-'));
const git=(...args)=>cp.execFileSync('git',['-c','user.name=lab','-c','user.email=lab@example.invalid','-c','commit.gpgsign=false',...args],{cwd:repo,encoding:'utf8',stdio:['pipe','pipe','pipe']}).trim();
git('init','-q','-b','main');writeFileSync(path.join(repo,'a.txt'),'a\n');git('add','a.txt');git('commit','-qm','base');
git('checkout','-qb','story/lab');writeFileSync(path.join(repo,'b.txt'),'b\n');git('add','b.txt');git('commit','-qm','story');
const head1=git('rev-parse','HEAD');
const originalExec=cp.execFileSync;let probes=[];
cp.execFileSync=function(file,args,...rest){if(file==='git'&&Array.isArray(args))probes.push(args.join(' '));return originalExec.call(this,file,args,...rest);};syncBuiltinESMExports();
const heads=()=>probes.filter(a=>a==='rev-parse HEAD').length;
try{
 const material1=currentMaterialHash(repo,'HEAD',repo),story1=currentStoryFilesHash(repo,'HEAD',repo);assert.ok(material1&&story1,'fixture hashes resolve');
 probes=[];currentGitHead(repo);currentGitHead(repo);assert.equal(heads(),2,'independent calls re-resolve HEAD');
 const row=()=>[checkEvidenceFreshnessForGit(repo,head1,material1,repo,story1),checkStrictVerificationEvidenceFreshnessForGit(repo,head1,material1,repo,story1)];
 probes=[];withVerificationRefreshObservation(()=>{const first=row();const afterFirst=probes.length;const more=[...row(),...row()];assert.ok([...first,...more].every(r=>r.fresh),'fixture rows are fresh');assert.equal(probes.length,afterFirst,'additional rows add no git probes inside one refresh scope');assert.equal(heads(),1,'one current HEAD observation per refresh scope');});
 withVerificationRefreshObservation(()=>{const before=currentGitHead(repo);writeFileSync(path.join(repo,'c.txt'),'c\n');git('add','c.txt');git('commit','-qm','moved');assert.equal(currentGitHead(repo),before,'a synchronous scope observes one coherent HEAD');});
 assert.notEqual(currentGitHead(repo),head1,'the next call outside the scope observes the moved HEAD');
 assert.throws(()=>withVerificationRefreshObservation(()=>{currentGitHead(repo);throw Error('abort');}),/abort/);
 probes=[];currentGitHead(repo);assert.equal(heads(),1,'a throwing scope releases its observation');
 await withVerificationRefreshObservation(async()=>{currentGitHead(repo);await Promise.resolve();probes=[];currentGitHead(repo);assert.equal(heads(),1,'no git state observation crosses await');});
 probes=[];withVerificationRefreshObservation(()=>{currentGitHead(repo);withVerificationRefreshObservation(()=>currentGitHead(repo));currentGitHead(repo);});assert.equal(heads(),1,'a nested scope shares the outer synchronous observation');
 // A freshness triple outside any scope is one observation of its own: one resolved HEAD and one tree read serve all three hashes.
 probes=[];const triple=captureVerificationFreshness(repo,repo);assert.equal(heads(),1,'a freshness triple resolves HEAD once');assert.equal(probes.filter(a=>a.startsWith('ls-tree ')).length,1,'a freshness triple reads its tree once for both projections');assert.equal(new Set(probes).size,probes.length,'a freshness triple never repeats a probe');assert.equal(triple.headHash,currentGitHead(repo),'the triple describes the current HEAD');
 probes=[];captureVerificationFreshness(repo,repo);captureVerificationFreshness(repo,repo);assert.equal(heads(),2,'independent triples re-resolve HEAD');
 console.log('GIT_STATE_OBSERVATION PASS one HEAD, material and story probe set per synchronous refresh scope; fresh outside; coherent under external movement; released on throw and await');
}finally{cp.execFileSync=originalExec;syncBuiltinESMExports();rmSync(repo,{recursive:true,force:true});}

// One synchronous segment observes the implementation once: producers forward their plan,
// completion and commit segments share one observation, launch stays independent.
{
 const {observedImplementationDigest,withVerificationCommitObservation}=await import('../dist/core/verification-execution-evidence.js');
 const forwarded=await recovery(...recoveryArgs,{plan:suppliedPlan});void forwarded;
 assert.equal(executionReads.at(-1).plan,suppliedPlan,'recovery forwards the supplied plan to enforcement');
 failPlan=false;await recovery(...recoveryArgs);assert.equal(executionReads.at(-1).plan,plan,'recovery forwards its own plan when none is supplied');
 // Producers: the plan is computed and forwarded within one synchronous segment.
 const producers=[];
 function findProducers(n){if(ts.isVariableDeclaration(n)&&n.name.getText(ast)==='currentPlan'&&n.initializer&&ts.isCallExpression(n.initializer)&&n.initializer.expression.getText(ast)==='verificationProducerPlan'){let block=n.parent;while(block&&!ts.isBlock(block))block=block.parent;producers.push({declaration:n,block});}ts.forEachChild(n,findProducers);}findProducers(ast);
 assert.equal(producers.length,3,'three producer entrypoints plan inside their locks');
 for(const {declaration,block} of producers){const statements=block.statements;const from=statements.findIndex(st=>st.getText(ast).includes(declaration.getText(ast)));const to=statements.findIndex((st,i)=>i>from&&st.getText(ast).includes('enforceWithPublicationRecovery('));assert.ok(from>=0&&to>from,'plan precedes recovery');
  for(const st of statements.slice(from,to)){const check=x=>{assert.notEqual(x.kind,ts.SyntaxKind.AwaitExpression,'no await between the producer plan and its recovery call');ts.forEachChild(x,check);};check(st);}
  let call;const findCall=x=>{if(ts.isCallExpression(x)&&x.expression.getText(ast)==='enforceWithPublicationRecovery')call=x;ts.forEachChild(x,findCall);};findCall(statements[to]);
  assert.equal(call.arguments[3]?.getText(ast).replace(/\s+/g,' '),'{ plan: currentPlan }','every producer forwards the plan it computed inside its lock');}
 // Scope inventory: every synchronous observation in the handler is bounded, never awaits, never launches
 // and never mutates git. Launches run inside withoutGitObservation and assert that no observation is active.
 const scopeCalls=name=>{const out=[];const visit=n=>{if(ts.isCallExpression(n)&&n.expression.getText(ast)===name)out.push(n);ts.forEachChild(n,visit);};visit(ast);return out;};
 const bodyText=call=>{const cb=call.arguments[0];if(ts.isIdentifier(cb))return cb.text;assert.ok(ts.isArrowFunction(cb)&&!cb.modifiers?.some(m=>m.kind===ts.SyntaxKind.AsyncKeyword),'observation callbacks are synchronous arrows');const text=cb.getText(ast);assert.ok(!/\bawait\b/.test(text)&&!text.includes('executeCausalEvidence(')&&!text.includes('runCommand(')&&!text.includes('executePinnedCommand(')&&!text.includes('autoCommitStoryMetadata('),'observation scopes never await, launch or mutate git');return text;};
 const planning=scopeCalls('withVerificationPlanningObservation').map(bodyText);assert.equal(planning.length,1,'one synchronous planning scope: the initial batch plans');assert.ok(planning[0].includes('verificationProducerPlan('));
 const launch=scopeCalls('withVerificationLaunchObservation').map(bodyText);assert.equal(launch.length,4,'three producers and the stale refresh prefix each open one launch observation');
 assert.equal(launch.filter(x=>x.includes('verificationProducerPlan(')&&x.includes('return enforceWithPublicationRecovery(')||x.includes('pending = enforceWithPublicationRecovery(')).length,3,'every producer plans and recovers inside its launch observation');
 assert.equal(launch.filter(x=>x.includes('planVerificationExecutionReuse(')&&x.includes('captureVerificationFreshness(')&&x.includes('preflightCausalEvidence(')).length,1,'the stale refresh prefix shares freshness, reuse planning, launch identity and causal preflight');
 const completion=scopeCalls('withVerificationCompletionObservation').map(bodyText);assert.equal(completion.length,3,'enforcement plus both stale refresh branches complete inside one observation');
 assert.equal(completion.filter(x=>x.includes('createVerificationExecutionReceipt(')).length,2,'fresh executions issue their execution receipt inside the completion observation');
 assert.equal(completion.filter(x=>x.includes('createCurrentVerificationAssertionReceipt(')||x.includes('publishCandidates')).length,3,'every assertion receipt publishes inside a completion observation');
 // Drift detection never compares two reads of one observation: the reuse-only publication rereads the identity in its own completion scope.
 assert.equal(completion.filter(x=>x.includes('assertVerificationInputUnchanged(reuse.identity')&&x.includes('prepareVerificationExecutionIdentity(')&&x.includes('publishCandidates()')).length,1,'the reuse-only publication rereads the launch identity inside its own completion observation');
 assert.ok(launch.every(x=>!x.includes('assertVerificationInputUnchanged(')),'no drift check compares two reads of the same launch observation');
 const launches=scopeCalls('withoutGitObservation');assert.equal(launches.length,2,'both launches run outside any git observation');for(const call of launches)assert.ok(call.arguments[0].getText(ast).includes('executeCausalEvidence('));
 assert.equal((source.match(/executeCausalEvidence\(/g)??[]).length,2,'no launch escapes withoutGitObservation');
 assert.equal((source.match(/assertGitObservationInactive\('launch revalidation'\)/g)??[]).length,2,'every launch revalidation asserts that no observation is active');
 // The checklist critical section is the only implicit git observation, and every git mutation it can reach invalidates it.
 const sections=scopeCalls('withGitTreeObservation').map(bodyText);assert.equal(sections.length,2,'two implicit observations: the checklist critical section and the evidence-hash triple');
 assert.ok(sections.includes('fn'),'the checklist lock helper forwards its callback into one observation');assert.equal(sections.filter(x=>x.includes('currentGitHead(')&&x.includes('currentMaterialHash(')&&x.includes('currentStoryFilesHash(')&&!x.includes('withChecklistLock(')).length,1,'the evidence-hash triple is its own observation and nothing more');
 let lockDeclaration;function findLock(n){if(ts.isFunctionDeclaration(n)&&n.name?.text==='withChecklistLock')lockDeclaration=n;ts.forEachChild(n,findLock);}findLock(ast);
 assert.ok(lockDeclaration&&lockDeclaration.getText(ast).includes('withGitTreeObservation(fn)'),'the checklist lock helper opens the observation around its synchronous callback');
 const checkpointSource=fs.readFileSync('packages/main/src/core/verification-intent-checkpoint.ts','utf8');assert.ok(/args\[0\]==='for-each-ref'\|\|args\[0\]==='log'\)\)return observedGit\(/.test(checkpointSource)&&checkpointSource.includes('finally{forgetGitObservation();}'),'checkpoint object and ref writes invalidate the observation');
 const autoCommitSource=fs.readFileSync('packages/main/src/core/auto-commit-metadata.ts','utf8');assert.equal((autoCommitSource.match(/forgetGitObservation\(\);/g)??[]).length,2,'the index and commit mutations of the metadata auto-commit invalidate the observation');
 // Commit: exactly one synchronous commit scope wrapping the canonical causal commit.
 const commits=[];function findCommits(n){if(ts.isCallExpression(n)&&n.expression.getText(ast)==='withVerificationCommitObservation')commits.push(n);ts.forEachChild(n,findCommits);}findCommits(ast);
 assert.equal(commits.length,3,'the canonical commit and the two single-row lock callbacks each hold one commit observation');
 const commitTexts=commits.map(bodyText);assert.equal(commitTexts.filter(x=>x.includes('revalidateFresh')&&x.includes('commitWithCacheInvalidation')&&x.includes('observedImplementationDigest()')).length,1,'commit scope holds both snapshots and the canonical write');
 assert.equal(commitTexts.filter(x=>x.includes('evidenceHashes(gitCwd, root)')&&x.includes('commitCanonicalCausalEvidence(')).length,2,'single-row lock callbacks bind their hashes and commit inside one observation');
 // Runtime: the commit scope shares one implementation read; outside it every call reads afresh.
 const originalRead=fs.readFileSync;let reads=0;fs.readFileSync=function(file,...rest){if(String(file)===anchor)reads++;return originalRead.call(this,file,...rest);};syncBuiltinESMExports();
 try{reads=0;const digests=withVerificationCommitObservation(()=>[observedImplementationDigest(),observedImplementationDigest(),observedImplementationDigest()]);assert.equal(reads,1,'one implementation read per synchronous commit scope');assert.ok(digests.every(d=>d===digests[0]));
  reads=0;observedImplementationDigest();observedImplementationDigest();assert.equal(reads,2,'independent reads outside a scope');
  assert.throws(()=>withVerificationCommitObservation(()=>{observedImplementationDigest();throw Error('abort');}),/abort/);reads=0;observedImplementationDigest();assert.equal(reads,1,'a throwing commit scope releases its observation');}
 finally{fs.readFileSync=originalRead;syncBuiltinESMExports();}
 console.log('SEGMENT_OBSERVATION_BOUNDARIES PASS plan forwarded by three producers and the recovery closure, one completion scope, one commit scope, independent outside');
}

// Identical read-only git probes run once per synchronous observation; launches run outside it.
{
 const cp=(await import('node:child_process')).default;const {mkdtempSync,rmSync,writeFileSync}=await import('node:fs');const {tmpdir}=await import('node:os');
 const {currentGitHead,gitCommitAtRef}=await import('../dist/core/evidence-freshness.js');
 const {withVerificationLaunchObservation,withVerificationCompletionObservation}=await import('../dist/core/verification-execution-evidence.js');
 const {withoutGitObservation,assertGitObservationInactive,observedGit}=await import('../dist/core/git-tree-observation.js');
 const repo=mkdtempSync(path.join(tmpdir(),'git-segment-observation-'));
 const git=(...args)=>cp.execFileSync('git',['-c','user.name=lab','-c','user.email=lab@example.invalid','-c','commit.gpgsign=false',...args],{cwd:repo,encoding:'utf8',stdio:['pipe','pipe','pipe']}).trim();
 git('init','-q','-b','main');writeFileSync(path.join(repo,'a.txt'),'a\n');git('add','a.txt');git('commit','-qm','base');
 const originalExec=cp.execFileSync;let probes=[];
 cp.execFileSync=function(file,args,...rest){if(file==='git'&&Array.isArray(args))probes.push(args.join(' '));return originalExec.call(this,file,args,...rest);};syncBuiltinESMExports();
 const heads=()=>probes.filter(a=>a==='rev-parse HEAD').length;
 try{
  probes=[];withVerificationLaunchObservation(()=>{currentGitHead(repo);currentGitHead(repo);gitCommitAtRef(repo,'HEAD');});assert.equal(heads(),1,'one identical probe per launch observation');
  probes=[];withVerificationCompletionObservation(()=>{currentGitHead(repo);currentGitHead(repo);});assert.equal(heads(),1,'one identical probe per completion observation');
  probes=[];withVerificationLaunchObservation(()=>{currentGitHead(repo);withoutGitObservation(()=>{assertGitObservationInactive('launch');currentGitHead(repo);});currentGitHead(repo);});assert.equal(heads(),2,'a launch inside withoutGitObservation rereads and leaves the outer observation intact');
  assert.throws(()=>withVerificationLaunchObservation(()=>assertGitObservationInactive('launch revalidation')),/git_observation_active/,'a launch inside an observation fails closed');
  assert.equal(assertGitObservationInactive('outside'),true);
  probes=[];withVerificationLaunchObservation(()=>{assert.equal(gitCommitAtRef(repo,'refs/heads/absent'),undefined);assert.equal(gitCommitAtRef(repo,'refs/heads/absent'),undefined);});assert.equal(probes.filter(a=>a==='rev-parse refs/heads/absent').length,1,'a failing probe is observed once per scope and fails the same way');
  probes=[];gitCommitAtRef(repo,'refs/heads/absent');gitCommitAtRef(repo,'refs/heads/absent');assert.equal(probes.filter(a=>a==='rev-parse refs/heads/absent').length,2,'outside an observation a failing probe runs each time');
  probes=[];currentGitHead(repo);currentGitHead(repo);assert.equal(heads(),2,'outside an observation every call probes git');
  // Only git's own refusal is memoized: caller deadline, timeout, buffer and spawn failures rerun for the next caller.
 withVerificationLaunchObservation(()=>{const refusal=Object.assign(new Error('refused'),{status:128,signal:null});for(const failure of [refusal,new Error('Git baseline observation budget exhausted'),Object.assign(new Error('timeout'),{status:null,signal:'SIGTERM',code:'ETIMEDOUT'}),Object.assign(new Error('buffer'),{status:0,signal:null,code:'ENOBUFS'}),Object.assign(new Error('spawn'),{status:null,signal:null,code:'ENOENT'})]){let runs=0;const probe=()=>observedGit(repo,['fake',failure.message],()=>{runs++;throw failure;});assert.throws(probe,failure);assert.throws(probe,failure);assert.equal(runs,failure===refusal?1:2,failure.message+(failure===refusal?': a refused command is observed once per scope':': an incomplete command is never memoized'));}});
 console.log('GIT_SEGMENT_OBSERVATION PASS identical probes run once per launch or completion observation, launches reread outside it and fail closed inside it, refusals observed once per scope, incomplete commands never memoized');
 }finally{cp.execFileSync=originalExec;syncBuiltinESMExports();rmSync(repo,{recursive:true,force:true});}
}

// A git mutation issued inside an observation invalidates it: the next read is fresh.
{
 const cp=(await import('node:child_process')).default;const {mkdtempSync,mkdirSync,rmSync,writeFileSync}=await import('node:fs');const {tmpdir}=await import('node:os');
 const {withGitTreeObservation,forgetGitObservation}=await import('../dist/core/git-tree-observation.js');
 const {readIntentCheckpoint,writeIntentCheckpoint}=await import('../dist/core/verification-intent-checkpoint.js');
 const {acceptanceIntentHash,createIntentAmendment}=await import('../dist/core/verification-intent-amendment.js');
 const {currentGitHead}=await import('../dist/core/evidence-freshness.js');
 const repo=mkdtempSync(path.join(tmpdir(),'git-mutation-observation-'));const storyDir=path.join(repo,'story','B-lab');mkdirSync(storyDir,{recursive:true});
 const git=(...args)=>cp.execFileSync('git',['-c','user.name=lab','-c','user.email=lab@example.invalid','-c','commit.gpgsign=false',...args],{cwd:repo,encoding:'utf8',stdio:['pipe','pipe','pipe']}).trim();
 git('init','-q','-b','main');writeFileSync(path.join(repo,'a.txt'),'a\n');git('add','a.txt');git('commit','-qm','base');
 const item={id:'CHK-001',title:'lab item',status:'todo',verificationIntent:{happy:[{id:'H1',desc:'lab happy path',type:'logic',priority:'must'}]}};
 const seeded=createIntentAmendment({item,storyId:'B-lab',expectedIntentHash:acceptanceIntentHash(item.verificationIntent),reason:'Seed a signed amendment so the checkpoint anchor write runs inside an observation.',addition:{edge:[{id:'E1',desc:'lab edge path',type:'logic',priority:'must'}]},sessionId:'lab',leaseId:'lab-lease',headHash:git('rev-parse','HEAD'),gitCwd:storyDir});
 const data={items:[{...item,verificationIntent:seeded.intent,verificationIntentAmendments:[seeded.amendment]}]};
 const originalExec=cp.execFileSync;let probes=[];
 cp.execFileSync=function(file,args,...rest){if(file==='git'&&Array.isArray(args))probes.push(args.join(' '));return originalExec.call(this,file,args,...rest);};syncBuiltinESMExports();
 try{
  withGitTreeObservation(()=>{
   assert.equal(readIntentCheckpoint('B-lab',storyDir),null,'no checkpoint yet');assert.equal(readIntentCheckpoint('B-lab',storyDir),null);
   writeIntentCheckpoint('B-lab',data,storyDir);
   const after=readIntentCheckpoint('B-lab',storyDir);assert.ok(after&&after.generation===1,'the checkpoint written inside the observation is visible to the next read');
  });
  probes=[];withGitTreeObservation(()=>{const head=currentGitHead(repo);forgetGitObservation();assert.equal(currentGitHead(repo),head);});assert.equal(probes.filter(a=>a==='rev-parse HEAD').length,2,'forgetting the observation makes the next probe run again');
  console.log('GIT_MUTATION_OBSERVATION PASS a checkpoint anchor written inside an observation is visible to the next read; forgetting reruns probes');
 }finally{cp.execFileSync=originalExec;syncBuiltinESMExports();rmSync(repo,{recursive:true,force:true});}
}
