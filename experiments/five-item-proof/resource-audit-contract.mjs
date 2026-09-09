import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const config=JSON.parse(readFileSync(root+'/proof-or-stop.config.json'));
const audit=JSON.parse(readFileSync(root+'/experiments/five-item-proof/resource-audit.json'));
const reverted=[3,6,40,79,81,105];
for(const index of reverted){const entry=audit.entries.find(e=>e.commandIndex===index);assert.equal(entry.supersededBy?.classification,'exclusive-local-writer','RESOURCE_AUDIT_SUPERSESSION_MISSING: '+index);assert.deepEqual(entry.supersededBy.effectiveResources,config.validate.commands[index].resources);}
const {verifyResourceAudit}=await import(root+'/experiments/five-item-proof/resource-audit-policy.mjs');
const summary=verifyResourceAudit(config,audit);assert.equal(summary.auditedReaders,21);assert.equal(summary.effectivelySharedReaders,15);assert.equal(summary.supersededReaders,6);
const extra=structuredClone(config);extra.validate.commands[117].resources.push({class:'fixed-path',key:'.proof-or-stop/runtime/validate-plan-barrier',access:'exclusive'});assert.throws(()=>verifyResourceAudit(extra,audit),/RESOURCE_AUDIT_DRIFT/,'Unapproved reader serialization must fail the real shared audit guard');
const weakened=structuredClone(config);weakened.validate.commands[3].resources=weakened.validate.commands[3].resources.filter(r=>r.key!=='.proof-or-stop/runtime/validate-plan-barrier');assert.throws(()=>verifyResourceAudit(weakened,audit),/RESOURCE_AUDIT_DRIFT/,'Removing a retained writer barrier must also fail');
console.log('RESOURCE_AUDIT_SUPERSESSION_AND_MUTATION_GUARDS_GREEN');
