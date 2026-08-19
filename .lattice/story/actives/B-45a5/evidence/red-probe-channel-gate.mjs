const WT='/Users/jek/Documents/Work/proofbound/.worktrees/B-45a5';
const { checkDispatchEvidence } = await import(`${WT}/packages/main/dist/handlers/validate-channel.js`);
const { withdrawnChecklistItemIdsFrom } = await import(`${WT}/packages/main/dist/core/proofstory.js`);

const decision = { decisionId:'SD-PROBE', decision:'confirmed', userConfirmed:true,
  withdrawnChecklistItemRefs:['CHK-002'], reason:'probe', approvedBy:'probe' };

const checklist = { items: [
  { id:'CHK-001', title:'delivered', status:'done' },
  { id:'CHK-002', title:'withdrawn by confirmed decision', status:'withdrawn', decisionRef:'SD-PROBE' },
]};
const events = [{ type:'dispatch', itemId:'CHK-001', at:'2026-01-01T00:00:00Z' }];

const r = checkDispatchEvidence({ checklist, events, mainAgentOwnedItems:new Set() });
const offenders = r.issues.map(i=>i.itemId);

console.log('\n=== B-45a5 probe: does the channel gate read a confirmed withdrawal? ===\n');
console.log('  helper says withdrawn set =', [...withdrawnChecklistItemIdsFrom(decision)]);
console.log('  gate ok      =', r.ok);
console.log('  gate issues  =', JSON.stringify(offenders));
const red = offenders.includes('CHK-002');
console.log(`\n  A CONTROL: delivered CHK-001 with dispatch evidence is NOT an offender -> ${!offenders.includes('CHK-001') ? 'CONTROL-OK' : 'BROKEN'}`);
console.log(`  B  RED   : withdrawn CHK-002 IS still demanded despite a confirmed decision -> ${red ? 'RED (gate ignores the withdrawal)' : 'GREEN'}`);
console.log(`\n  ${red?1:0} RED. The helper resolves the withdrawal; checkDispatchEvidence never consults it (its opts carry no decision at all).\n`);
process.exit(red ? 1 : 0);
