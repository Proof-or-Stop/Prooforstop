import ts from 'typescript';
import {execFileSync,spawnSync} from 'node:child_process';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

// Deterministic internal-state unit controls, separate from the real native
// lifecycle below. These maps/predicates create no reservation or authority.
const retirementSource=readFileSync(new URL('../../packages/main/src/core/validation-reservation-delegation.ts',import.meta.url),'utf8');
const retirementStart='  const retireReleasedGrants = () => {';
const retirementEnd='  const drain = () => {';
assert.equal(retirementSource.split(retirementStart).length,2);
assert.equal(retirementSource.split(retirementEnd).length,2);
const retirementBody=retirementSource.slice(retirementSource.indexOf(retirementStart),retirementSource.indexOf(retirementEnd));
function retirementFixture({pending=false,registeredLive=false,subjectLive=false,connectedLeaf=false,single=false,branching=false}={}) {
 const names=single?['a']:branching?['a','b','c','d']:['a','b','c'];
 const active=new Map(names.map((id,i)=>[id,{grantId:id,parents:branching&&id==='d'?['a']:names.slice(0,i),disconnected:!(connectedLeaf&&id==='c'),terminal:true,subject:{pid:i+100,pgid:i+100},resources:null}]));
 const context={active,pendingChildren:new Map(pending?[['pending',{parents:['a','b']}]]:[]),registered:new Map(registeredLive?[[101,{parents:['a','b'],pgid:777}]]:[]),grantTimers:new Map(),clearTimeout,groupGone:()=>!registeredLive,subjectGroupWorkPresent:(subject,terminal)=>{assert.equal(terminal,true);return subjectLive&&subject.pid===102;}};
 return {active,retire:vm.runInNewContext(retirementBody+'\nretireReleasedGrants;',context)};
}
for(const [options,expected]of [[{},0],[{branching:true},0],[{pending:true},2],[{registeredLive:true},2],[{subjectLive:true},3],[{connectedLeaf:true},3],[{single:true},0]]) {
 const fixture=retirementFixture(options);fixture.retire();
 assert.equal(fixture.active.size,expected,'EXHAUSTED_DESCENDANTS_SINGLE_DRAIN '+JSON.stringify(options));
}
console.log('NESTED_RETIREMENT_ORDER_UNIT_CONTROLS PASS');

// Resolved-enrollment pruning unit controls on the extracted closure: a row leaves the record only
// when its PID and whole group are both proven absent (so the exact predicate registration uses for
// enrollment immutability no longer holds for that PID), the pruned row's consumed capability
// survives one bounded cleanup window and then expires, and a live or half-observed row stays.
const pruneStart='  const pruneResolvedEnrollments = (): boolean => {';
const pruneEnd='  const retireReleasedGrants = () => {';
assert.equal(retirementSource.split(pruneStart).length,2);
const pruneBody=retirementSource.slice(retirementSource.indexOf(pruneStart),retirementSource.indexOf(pruneEnd));
const pruneCompiled=ts.transpileModule(pruneBody+'\npruneResolvedEnrollments;',{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None}}).outputText;
function pruneFixture({gonePids=[],goneGroups=[]}={}) {
 const registered=new Map([[101,{pid:101,pgid:101,start:1,parents:['a']}],[202,{pid:202,pgid:202,start:2,parents:['a']}]]);
 const registeredTokens=new Map([[101,'t101'],[202,'t202']]);
 const consumedPending=new Map([['t101',{capability:'c101'}],['t202',{capability:'c202'}],['t303',{capability:'c303',expiresAt:500}]]);
 const clock={now:1000};
 const context={registered,registeredTokens,consumedPending,registrationTargetGone:pid=>gonePids.includes(pid),groupGone:pgid=>goneGroups.includes(pgid),CLEANUP_MS:2000,Date:{now:()=>clock.now}};
 return {registered,registeredTokens,consumedPending,clock,prune:vm.runInNewContext(pruneCompiled,context)};
}
{
 const resolved=pruneFixture({gonePids:[101],goneGroups:[101]});
 assert.equal(resolved.prune(),true,'PRUNE_RESOLVED_ENROLLMENT_REQUIRED');assert.equal(resolved.registered.has(101),false,'resolved enrollment must be pruned');assert.equal(resolved.registered.has(202),true,'live enrollment must stay');assert.equal(resolved.registeredTokens.has(101),false);
 assert.deepEqual(resolved.consumedPending.get('t101'),{capability:'c101',expiresAt:5000},'pruned capability survives one bounded window');assert.equal(resolved.consumedPending.has('t303'),false,'expired capability is dropped');
 resolved.clock.now=5000;assert.equal(resolved.prune(),false);assert.equal(resolved.consumedPending.has('t101'),false,'capability expires after its window');assert.equal(resolved.consumedPending.has('t202'),true);
 const half=pruneFixture({gonePids:[101],goneGroups:[]});assert.equal(half.prune(),false);assert.equal(half.registered.has(101),true,'a PID absent with its group present stays fenced');
 const live=pruneFixture();assert.equal(live.prune(),false);assert.equal(live.registered.size,2);
}
console.log('NESTED_ENROLLMENT_PRUNING_UNIT_CONTROLS PASS');

// Pending-fence resolution unit controls on the extracted predicate: an unmarked fence resolves on owner
// loss alone; a marked fence resolves only through its noted spawned PID, and only once the owner is
// provably gone and that PID and whole group are absent; a marked fence without a note stays terminal.
const resolvedCompiled=ts.transpileModule(identityDeclaration(retirementSource,'pendingRowResolved')+'\npendingRowResolved;',{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None}}).outputText;
function resolvedUnit({ownerGone=false,gonePids=[]}={}){return vm.runInNewContext(resolvedCompiled,{registrationTargetGone:pid=>gonePids.includes(pid),pendingOwnerGone:()=>ownerGone});}
{
 const row=extra=>({pid:100,start:1,...extra});
 assert.equal(resolvedUnit({ownerGone:true})(row({})),true,'unmarked fence resolves on owner loss');
 assert.equal(resolvedUnit({ownerGone:false})(row({})),false,'unmarked fence with a live owner stays');
 assert.equal(resolvedUnit({ownerGone:true})(row({spawnAttempted:true})),false,'marked fence without a note stays terminal');
 assert.equal(resolvedUnit({ownerGone:true,gonePids:[555]})(row({spawnAttempted:true,spawnedPid:555})),true,'NOTED_FENCE_RESOLVES_ON_OWNER_AND_CHILD_ABSENCE');
 assert.equal(resolvedUnit({ownerGone:false,gonePids:[555]})(row({spawnAttempted:true,spawnedPid:555})),false,'noted fence with a live owner stays');
 assert.equal(resolvedUnit({ownerGone:true})(row({spawnAttempted:true,spawnedPid:555})),false,'noted fence with a live child stays');
 assert.equal(resolvedUnit({ownerGone:false,gonePids:[555]})(row({target:{pid:555,pgid:555,start:2}})),true,'observed target resolves on absence');
 assert.equal(resolvedUnit({ownerGone:true,gonePids:[555]})(row({target:{pid:555,pgid:556,start:2}})),false,'non-leader target never resolves');
}
console.log('NESTED_PENDING_RESOLUTION_UNIT_CONTROLS PASS');

// Doctor projection unit controls on the exported function, extracted and transpiled like the closures
// above: a targetless pending fence under a live owner is in flight, never fenced; the same fence under a
// dead owner is fenced; every other fencing shape still fences; an empty classification does not.
{
 const projectionStart='export function fencedMachineTicketProjection(';
 const projectionEnd='/** Failure-only diagnostics; these observations never release or authorize work. */';
 assert.equal(retirementSource.split(projectionStart).length,2);assert.equal(retirementSource.split(projectionEnd).length,2);
 const projectionBody=retirementSource.slice(retirementSource.indexOf(projectionStart)+'export '.length,retirementSource.indexOf(projectionEnd));
 const extracted=vm.runInNewContext(ts.transpileModule(projectionBody+'\nfencedMachineTicketProjection;',{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText,{});
 // Spread into this realm so strict deep equality is not defeated by the vm realm's own Object prototype.
 const projection=residuals=>({...extracted(residuals)});
 const empty={present:true,malformed:false,registeredLive:0,registeredResolved:0,pendingTargetLive:0,pendingTargetResolved:0,pendingTargetless:0,pendingUnattemptedResolved:0,pendingSpawnedLive:0,pendingSpawnedResolved:0,deadOwners:0};
 assert.deepEqual(projection({...empty,pendingTargetless:1}),{fenced:false,deadOwnerTargetless:0,inFlight:1},'LIVE_OWNER_FENCE_IS_IN_FLIGHT');
 assert.deepEqual(projection({...empty,pendingTargetless:2,deadOwners:1}),{fenced:true,deadOwnerTargetless:1,inFlight:1},'DEAD_OWNER_FENCE_IS_FENCED');
 for(const shape of [{registeredLive:1},{pendingTargetLive:1},{pendingSpawnedLive:1},{malformed:true}])assert.equal(projection({...empty,...shape}).fenced,true,JSON.stringify(shape));
 assert.equal(projection(empty).fenced,false);
 console.log('NESTED_FENCE_PROJECTION_UNIT_CONTROLS PASS');
}

// Actual identity-function controls with explicit stubbed ps output, plus a real
// absent-PID refusal. Observation stubs are unit inputs, never kernel authority.
const mkdirIdentitySource=readFileSync(new URL('../../packages/main/src/core/mkdir-lock.ts',import.meta.url),'utf8');
function identityDeclaration(source,name){const file=ts.createSourceFile('identity.ts',source,ts.ScriptTarget.Latest,true);const rows=file.statements.filter(node=>ts.isFunctionDeclaration(node)&&node.name?.text===name);assert.equal(rows.length,1,name);return rows[0].getText(file).replace(/^export /,'');}
function identityClassDeclaration(source,name){const file=ts.createSourceFile('identity.ts',source,ts.ScriptTarget.Latest,true);const rows=file.statements.filter(node=>ts.isClassDeclaration(node)&&node.name?.text===name);assert.equal(rows.length,1,name);return rows[0].getText(file).replace(/^export /,'');}
// The typed refusal class is part of the extracted failure helper's real source; the unit sandbox loads it verbatim.
const identityFunctions=identityClassDeclaration(retirementSource,'ValidationDelegationError')+'\n'+['failure','table','identity'].map(name=>identityDeclaration(retirementSource,name)).join('\n')+'\n'+identityDeclaration(mkdirIdentitySource,'observedProcessStartTimeMs');
const identityCompiled=ts.transpileModule(identityFunctions+'\nidentity;',{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None}}).outputText;
function identityUnit(query){return vm.runInNewContext(identityCompiled,{execFileSync:query,policy:{kernelObservationMs:1000}});}
const observationDate='Sun Sep 13 18:00:00 2026';let observationQueries=0;
const identityPositive=identityUnit((_file,args)=>{observationQueries++;if(args.includes('pid=,ppid=,pgid='))return '321 1 321\n';if(args.includes('lstart='))return observationDate;return '321 321 '+observationDate;});
assert.equal(JSON.stringify(identityPositive(321)),JSON.stringify({pid:321,start:Date.parse(observationDate),pgid:321}));
assert.equal(observationQueries,1,'IDENTITY_SINGLE_COHERENT_QUERY_REQUIRED');
for(const raw of ['', '999 321 '+observationDate,'321 0 '+observationDate,'321 321 invalid','321 321 '+observationDate+'\n321 321 '+observationDate])assert.throws(()=>identityUnit(()=>raw)(321),/process identity unavailable/);
assert.throws(()=>identityUnit(()=>{throw Error('controlled observation unavailable');})(321),/process identity unavailable/);
for(const pid of [0,1,-1,NaN,Infinity,1.5]){let calls=0;assert.throws(()=>identityUnit(()=>{calls++;throw Error('INVALID_PID_SPAWNED');})(pid),/process identity unavailable/);assert.equal(calls,0,'invalid PID must not spawn ps');}
const exitedIdentityChild=spawnSync(process.execPath,['-e',''],{encoding:'utf8',timeout:1000,maxBuffer:1024});
assert.equal(exitedIdentityChild.error,undefined,'identity child setup unavailable');
assert.equal(exitedIdentityChild.status,0,'identity child did not exit successfully');
assert.equal(exitedIdentityChild.signal,null,'identity child must be reaped normally');
const absentPid=exitedIdentityChild.pid;
assert.ok(Number.isSafeInteger(absentPid)&&absentPid>1);
let pidAbsent=false;try{process.kill(absentPid,0);}catch(error){pidAbsent=error.code==='ESRCH';}
assert.equal(pidAbsent,true,'identity absent-PID control unavailable');
assert.throws(()=>identityUnit(execFileSync)(absentPid),/process identity unavailable/);
console.log('NESTED_IDENTITY_OBSERVATION_UNIT_CONTROLS PASS');

// Source-only native protocol controls, embedded into the actual isolated worker.
export function nestedReservationLifecycleProgram({loader, delegation, lock}) {
 return `
const {spawn}=await import('node:child_process');
const api=await import(${JSON.stringify(delegation)});
const childFile=root+'/reservation-lifecycle-child.mjs';
writeFileSync(childFile,${JSON.stringify(`import ${JSON.stringify(loader)};
const api=await import(${JSON.stringify(delegation)});
const {withMachineValidationResources:machine}=await import(${JSON.stringify(lock)});
const message=()=>new Promise(resolve=>process.once('message',resolve));
const go=await message();
await api.confirmValidationReservationRegistration({deadlineAt:go.deadlineAt});
await machine({root:go.root,workspaceRoot:go.root,command:'registered-lifecycle-child',deadlineAt:go.deadlineAt},async()=>{
 const signal=api.currentValidationReservationAbortSignal();
 process.send({ready:true});
 await new Promise(resolve=>{if(signal.aborted)resolve();else signal.addEventListener('abort',resolve,{once:true});});
 let refused=false;try{await machine({root:go.root,workspaceRoot:go.root,command:'revoked-child-entry',deadlineAt:go.deadlineAt},()=>{throw Error('UNEXPECTED_REVOKED_ENTRY');});}catch(error){refused=/revocation|released|expired/.test(error.message);}
 if(!refused)throw Error('revoked child nested entry was not refused');
 process.send({revoked:true});
 await message();
});
process.disconnect();`)});
for(const kind of ['release','expiry']) {
 let child, descendant, readyResolve, revokedResolve, childClosed, childError;
 const ready=new Promise(resolve=>{readyResolve=resolve;});
 const revoked=new Promise(resolve=>{revokedResolve=resolve;});
 const deadlineAt=Date.now()+ (kind==='expiry'?3500:10000);
 let releaseParent;
 const parentHold=new Promise(resolve=>{releaseParent=resolve;});
 const a=machine({...options(),deadlineAt},async()=>{
  descendant=machine({...options(),deadlineAt},async()=>{
   const token=await api.prepareValidationReservationChild({deadlineAt});await api.attemptValidationReservationSpawn(token,{deadlineAt});
   child=spawn(process.execPath,[childFile],{env:api.validationReservationChildEnvironment(process.env),stdio:api.validationReservationChildStdio(['ignore','inherit','inherit','ipc']),detached:true});
   childClosed=new Promise(resolve=>child.once('close',(code,signal)=>{if(code!==0)childError=Error('lifecycle child failed '+code+'/'+signal);resolve();}));
   child.on('error',error=>{childError=error;readyResolve();revokedResolve();});
   child.on('message',message=>{if(message.ready)readyResolve();if(message.revoked)revokedResolve();});
   await api.registerValidationReservationChild(child.pid,token,{deadlineAt});
   child.send({root,deadlineAt});
   await childClosed;
  });
  await ready;
  if(kind==='expiry')await parentHold;
 });
 await ready;
 if(kind==='release')await a;
 await revoked;
 assert.equal(childError,undefined);
 // A caller cannot launder an existing enrollment into a root-level lineage.
 const duplicate=await api.prepareValidationReservationChild();
 await assert.rejects(()=>api.registerValidationReservationChild(child.pid,duplicate),/immutable/);
 await api.cancelValidationReservationChild(duplicate); // No second spawn occurred.
 let siblingEntered=false;
 const sibling=machine(options(),()=>{siblingEntered=true;});
 await wait(30);assert.equal(siblingEntered,false,'revoked live descendant lost its claims');
 child.send({finish:true});await childClosed;releaseParent();
 await Promise.all([a,descendant,sibling]);assert.equal(childError,undefined);
 console.log('NESTED_TRANSITIVE_'+kind.toUpperCase()+'_AND_IMMUTABLE_ENROLLMENT PASS');
}
`;
}
