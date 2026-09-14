import assert from 'node:assert/strict';
import ts from 'typescript';
import fs from 'node:fs';import path from 'node:path';import {syncBuiltinESMExports} from 'node:module';
import {prepareVerificationExecutionIdentity,withVerificationPlanningObservation,withVerificationRefreshObservation} from '../dist/core/verification-execution-evidence.js';
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
 async(_item,_input,deps)=>{executionReads.push({implementation,shared:deps.sharedExecutionReceipt});await Promise.resolve();return {evidencePatch:{result:'fail'}};},
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
 console.log('GIT_STATE_OBSERVATION PASS one HEAD, material and story probe set per synchronous refresh scope; fresh outside; coherent under external movement; released on throw and await');
}finally{cp.execFileSync=originalExec;syncBuiltinESMExports();rmSync(repo,{recursive:true,force:true});}
