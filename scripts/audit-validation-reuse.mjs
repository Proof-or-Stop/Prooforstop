#!/usr/bin/env node
// Read-only configuration inventory; absence of a prohibition is not an input audit.
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {resolve,join} from 'node:path';import {fileURLToPath} from 'node:url';
const root=resolve(fileURLToPath(new URL('..',import.meta.url)));
const {configuredValidationCommands}=await import('../packages/main/dist/handlers/verifier.js');
const {resolveDoneRequiredPolicy}=await import('../packages/main/dist/core/done-required-validation.js');
const {sharedValidationReusePolicy}=await import('../packages/main/dist/core/shared-validation-execution.js');
const config=JSON.parse(readFileSync(join(root,'proof-or-stop.config.json')));
const mode=config.validation?.dynamic?.mode??config.validate?.dynamic?.mode??'off';
const rows=[...configuredValidationCommands(root).map((command,index)=>({consumer:'validate',index,command})),...resolveDoneRequiredPolicy(root).commands.map((command,index)=>({consumer:'done_required',index,command}))].map(row=>{
 const policy=sharedValidationReusePolicy(row.command);
 return {...row,policy,dynamicMode:row.consumer==='validate'?mode:null,
  activationBlockers:[...(!policy.eligible?[policy.reason]:[]),...(row.consumer==='validate'&&mode!=='off'?['shared_execution_disabled_by_dynamic_mode']:[])],
  inputClosureAudit:policy.reason==='not_opted_in'||policy.reason==='inputs_undeclared'?'not_completed_do_not_enable':'not_a_reuse_authorization'};
});
const totals=rows.reduce((acc,row)=>(acc[row.policy.reason]=(acc[row.policy.reason]??0)+1,acc),{});
const result={schema:'lab.validation-reuse-inventory.v1',mode,total:rows.length,totals,rows,formalLifecycleEvidence:false};
if(process.env.REUSE_PROOF_OUTPUT){mkdirSync(process.env.REUSE_PROOF_OUTPUT,{recursive:true});writeFileSync(join(process.env.REUSE_PROOF_OUTPUT,'production-inventory.json'),JSON.stringify(result,null,2));}
console.log(JSON.stringify({total:rows.length,mode,totals}));
