import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {withOfficialValidationExecution,withWorkspaceValidationCapacity} from '../dist/core/validation-execution-lock.js';
import {acquireOwnerLease} from '../dist/core/story-owner-lease.js';
const original=AbortSignal.any;let failures=0;
try {
 {
  const root=mkdtempSync(join(tmpdir(),'pos-nested-abort-'));
  try {
   const owner=join(root,'.proof-or-stop/story/actives/B-nested');acquireOwnerLease(owner,{command:'validate',cwd:root});
   const abort=new AbortController();abort.abort(new Error('nested original reason'));let callback=0;
   await withWorkspaceValidationCapacity({root,workspaceRoot:root,command:'outer'},async()=>{
    await assert.rejects(()=>withOfficialValidationExecution({root,workspaceRoot:root,command:'validate',storyId:'B-nested',ownerLeaseDir:owner,abortSignal:abort.signal},()=>{callback++;}),/nested original reason/);
   });
   assert.equal(callback,0);console.log('PASS nested capacity reuse refuses aborted caller');
  } catch(e){failures++;console.error('ABORT_COMPOSITION_COMPAT_RED nested: '+e.message);}
  finally{rmSync(root,{recursive:true,force:true});}
 }
 AbortSignal.any=undefined;
 for(const kind of ['no-caller','healthy-caller','already-aborted','callback-failure']) {
  const root=mkdtempSync(join(tmpdir(),'pos-abort-compat-'));let added=0,removed=0,callback=0;
  try {
   const storyDir=join(root,'.proof-or-stop/story/actives/B-compat');acquireOwnerLease(storyDir,{command:'validate',cwd:root});
   const caller=new AbortController();const add=caller.signal.addEventListener.bind(caller.signal),remove=caller.signal.removeEventListener.bind(caller.signal);
   caller.signal.addEventListener=(...args)=>{if(args[0]==='abort')added++;return add(...args);};caller.signal.removeEventListener=(...args)=>{if(args[0]==='abort')removed++;return remove(...args);};
   if(kind==='already-aborted')caller.abort(new Error('original caller reason'));
   const execute=()=>withOfficialValidationExecution({root,workspaceRoot:root,command:'validate',storyId:'B-compat',ownerLeaseDir:storyDir,
    ...(kind==='no-caller'?{}:{abortSignal:caller.signal})},()=>{callback++;if(kind==='callback-failure')throw new Error('original callback reason');return 'accepted';});
   if(kind==='already-aborted'){await assert.rejects(execute,/original caller reason/);assert.equal(callback,0);}
   else if(kind==='callback-failure'){await assert.rejects(execute,/original callback reason/);assert.equal(callback,1);}
   else {assert.equal(await execute(),'accepted');assert.equal(callback,1);}
   assert.ok(removed>=added,'forwarding listeners must be removed when the operation settles');
   console.log('PASS abort composition '+kind+' '+JSON.stringify({callback,added,removed}));
  } catch(e){failures++;console.error('ABORT_COMPOSITION_COMPAT_RED '+kind+': '+e.message);}
  finally{rmSync(root,{recursive:true,force:true});}
 }
}finally{AbortSignal.any=original;}
if(failures)process.exitCode=1;else console.log('ABORT_COMPOSITION_COMPAT_GREEN');
