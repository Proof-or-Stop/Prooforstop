import assert from 'node:assert/strict';
import fs from 'node:fs';
const root=process.argv[2];
const {verifyResourceAudit,commandFor}=await import(root+'/experiments/five-item-proof/resource-audit-policy.mjs');
const config=JSON.parse(fs.readFileSync(root+'/proof-or-stop.config.json')),audit=JSON.parse(fs.readFileSync(root+'/experiments/five-item-proof/resource-audit.json'));
const entry=audit.entries.find(e=>e.recommendation==='safe-to-declare-shared'&&!e.supersededBy),c=commandFor(config,entry.argv);
c.command=c.command+' '+c.args.shift();
assert.throws(()=>verifyResourceAudit(config,audit),/AUDITED_COMMAND_DRIFT/,'AUDIT_ARGV_BOUNDARY_LOSS: identical display text must not authorize a different executable/argv boundary');
console.log('AUDIT_ARGV_BOUNDARIES_GREEN');
