#!/usr/bin/env node
// Lab-only pure contract prototype. No production Story file or new CLI authority.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdirSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {buildVerificationCoverage} from '../../packages/main/dist/core/verification.js';
import {createChecklistHandlers} from '../../packages/main/dist/handlers/checklist.js';
const output=process.env.FIVE_ITEM_PROOF_OUTPUT||join(tmpdir(),'five-acceptance-'+Date.now());mkdirSync(output,{recursive:true});
const hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const original={id:'CHK-001',title:'Add arithmetic acceptance',context:'Keep the original requirement',status:'done',verificationIntent:{happy:[{id:'OLD',desc:'Original case must pass',type:'cli',priority:'must'}],edge:[],adversarial:[]},verificationEvidence:[]};
// Authority is an input from the host in this prototype, not a signed production fact.
function appendOnly(item,{expectedHash,authorizedOwner,reason,addition}){
 assert.equal(authorizedOwner,true,'OWNER_REQUIRED');assert.equal(expectedHash,hash(item.verificationIntent),'STALE_ACCEPTANCE_BASE');assert.ok(reason?.length>=30,'SUBSTANTIVE_REASON_REQUIRED');
 const next=structuredClone(item),ids=new Set(Object.values(item.verificationIntent).flat().map(x=>x.id));
 for(const lane of ['happy','edge','adversarial'])for(const row of addition[lane]||[]){assert.ok(row.id&&!ids.has(row.id),'DUPLICATE_OR_REPLACED_INTENT');assert.equal(row.priority,'must','ADDED_INTENT_MUST_BLOCK');assert.ok(['cli','cli_blackbox','logic','integration'].includes(row.type),'EXECUTABLE_ACCEPTANCE_REQUIRED');assert.ok(!row.verification&&!row.plannedPathDeclarations,'NO_CALLER_RECEIPT_OR_SCOPE_EXPANSION');ids.add(row.id);next.verificationIntent[lane].push(structuredClone(row));}
 assert.ok(ids.size>Object.values(item.verificationIntent).flat().length,'NONEMPTY_ADDITION_REQUIRED');
 next.status='in_progress';return {item:next,audit:{before:hash(item.verificationIntent),after:hash(next.verificationIntent),reason,original:structuredClone(item.verificationIntent)}};
}
const add={happy:[{id:'NEW',desc:'New boundary case must pass too',type:'cli',priority:'must'}],edge:[],adversarial:[]};
let writes=0;const h=createChecklistHandlers({root:output,store:{readStory:()=>({storyId:'EXPERIMENT',phase:'DEV'}),storyDirPath:()=>join(output,'no-real-story'),readChecklist:()=>({items:[structuredClone(original)]}),writeChecklist:()=>{writes++;},runtimeLockDirPath:(_id,...parts)=>join(output,'locks',...parts)}});
const proposed=structuredClone(original.verificationIntent);proposed.happy.push(add.happy[0]);
assert.throws(()=>h.checklist_update({storyId:'EXPERIMENT',itemId:'CHK-001',verificationIntent:proposed}),/cannot be modified/);assert.equal(writes,0);
const request={expectedHash:hash(original.verificationIntent),authorizedOwner:true,reason:'The identified boundary case adds coverage and preserves all existing acceptance.',addition:add};
const green=appendOnly(original,request);assert.deepEqual(green.item.verificationIntent.happy[0],original.verificationIntent.happy[0]);assert.deepEqual(green.item.verificationEvidence,original.verificationEvidence);assert.equal(original.status,'done');
const coverage=buildVerificationCoverage({items:[green.item]});assert.equal(coverage.required,2);assert.equal(coverage.missingRequired,2);assert.ok(coverage.entries.some(e=>e.intentRef==='NEW'&&e.status==='missing'));
for(const bad of [{...request,authorizedOwner:false},{...request,expectedHash:'stale'},{...request,reason:'short'},{...request,addition:{happy:[{...add.happy[0],id:'OLD'}]}},{...request,addition:{happy:[{...add.happy[0],priority:'should'}]}},{...request,addition:{happy:[{...add.happy[0],verification:{command:'true',selector:'',result:'pass'}}]}}])assert.throws(()=>appendOnly(original,bad));
assert.throws(()=>appendOnly(green.item,request),/STALE_ACCEPTANCE_BASE/);
writeFileSync(join(output,'acceptance.json'),JSON.stringify({currentHandlerRed:'frozen DEV replacement refused, zero writes',prototypeGreen:{originalPreserved:true,newAcceptanceBlocks:true,negativeControls:7,audit:green.audit,coverage},productionStatus:'NOT_INTEGRATED: owner attestation is a prototype input, no signed amendment/dispatch/lifecycle channel has been implemented',timing:{redSuccessfulCompletionMs:null,greenProductionCompletionMs:null,reductionPercent:null}},null,2));
console.log('ACCEPTANCE_CONTRACT_PROTOTYPE_GREEN; PRODUCTION_AMENDMENT_NOT_PROVEN');
