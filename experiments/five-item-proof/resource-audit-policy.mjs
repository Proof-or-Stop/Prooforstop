import assert from 'node:assert/strict';
const barrier=r=>r.class==='fixed-path'&&r.key==='.proof-or-stop/runtime/validate-plan-barrier'&&r.access==='exclusive';
export const argvOf=c=>[c.command,...c.args].join(' ');
export function commandFor(config,argv){
 const matches=config.validate.commands.filter(c=>argvOf(c)===argv);
 assert.equal(matches.length,1,'AUDITED_COMMAND_DRIFT: '+argv);
 return matches[0];
}
export function verifyResourceAudit(config,audit){
 const reviewed=audit.entries.filter(e=>e.recommendation==='safe-to-declare-shared');let effectivelySharedReaders=0,supersededReaders=0;
 assert.equal(new Set(reviewed.map(e=>e.argv)).size,reviewed.length,'DUPLICATE_AUDIT_COMMAND');
 for(const entry of reviewed){
  const command=commandFor(config,entry.argv),supersession=entry.supersededBy;
  assert.ok(!supersession?.effectiveArgv,'AUDITED_ARGV_SUPERSESSION_INVALID');
  if(supersession){
   const buildPrecheck=supersession.classification==='exclusive-build-precheck'&&entry.argv==='node scripts/verify-lab-worktree.mjs'&&config.validate.commands[0]===command&&argvOf(config.validate.commands[1])==='npm --prefix packages/main run build'&&config.validate.commands[1].resources.some(barrier);
   assert.ok(supersession.classification==='exclusive-local-writer'||buildPrecheck,'RESOURCE_AUDIT_SUPERSESSION_INVALID');
   assert.ok(supersession.reference&&supersession.effectiveResources.some(barrier),'RESOURCE_AUDIT_SUPERSESSION_INVALID');
   for(const claim of entry.suggestedResources)assert.ok(supersession.effectiveResources.some(actual=>JSON.stringify(actual)===JSON.stringify(claim)),'RESOURCE_AUDIT_WITHDRAWN_CLAIM: '+entry.argv);
   supersededReaders++;
  }
  assert.deepEqual(command.resources,supersession?.effectiveResources??entry.suggestedResources,'RESOURCE_AUDIT_DRIFT: '+entry.argv);
  if(!command.resources.some(barrier))effectivelySharedReaders++;
 }
 return {auditedReaders:reviewed.length,effectivelySharedReaders,supersededReaders};
}
