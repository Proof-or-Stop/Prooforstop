import assert from 'node:assert/strict';
const barrier=r=>r.class==='fixed-path'&&r.key==='.proof-or-stop/runtime/validate-plan-barrier'&&r.access==='exclusive';
export function verifyResourceAudit(config,audit){
 const reviewed=audit.entries.filter(e=>e.recommendation==='safe-to-declare-shared');let effectivelySharedReaders=0,supersededReaders=0;
 for(const entry of reviewed){
  const command=config.validate.commands[entry.commandIndex];assert.equal([command.command,...command.args].join(' '),entry.argv,'AUDITED_COMMAND_DRIFT');
  const supersession=entry.supersededBy;
  if(supersession){assert.equal(supersession.classification,'exclusive-local-writer','RESOURCE_AUDIT_SUPERSESSION_INVALID');assert.ok(supersession.reference&&supersession.effectiveResources.some(barrier),'RESOURCE_AUDIT_SUPERSESSION_INVALID');supersededReaders++;}
  if(supersession)for(const claim of entry.suggestedResources)assert.ok(supersession.effectiveResources.some(actual=>JSON.stringify(actual)===JSON.stringify(claim)),'RESOURCE_AUDIT_WITHDRAWN_CLAIM: '+entry.commandIndex);
  assert.deepEqual(command.resources,supersession?.effectiveResources??entry.suggestedResources,'RESOURCE_AUDIT_DRIFT: '+entry.commandIndex);
  if(!command.resources.some(barrier))effectivelySharedReaders++;
 }
 return {auditedReaders:reviewed.length,effectivelySharedReaders,supersededReaders};
}
