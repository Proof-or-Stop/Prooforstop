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
   const token=await api.prepareValidationReservationChild({deadlineAt});
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
