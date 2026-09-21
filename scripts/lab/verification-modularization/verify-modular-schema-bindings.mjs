import assert from 'node:assert/strict';
import './../../../scripts/identity-cutover/bootstrap.mjs';
import {schemaRows} from '../../identity-cutover/schema-scan.mjs';
import {trackedFiles} from '../../identity-cutover/repository.mjs';
import {verifySchemaInventory} from '../../identity-cutover/source-integrity.mjs';
const root=process.cwd(),rows=schemaRows(root,trackedFiles(root));
assert.deepEqual(verifySchemaInventory(root,rows),[],'MODULAR_SCHEMA_BINDINGS_STALE: preserve schema occurrences across module paths');
console.log('MODULAR_SCHEMA_BINDINGS_GREEN '+JSON.stringify({rows:rows.length}));
await import('./verify-schema-migration-data.mjs');
await import('./verify-modular-audit-contexts.mjs');
const {CURRENT_COMPATIBLE_SCHEMA_ROWS}=await import('../../identity-cutover/schema-data.mjs');
let rejected=0;
for(const pin of CURRENT_COMPATIBLE_SCHEMA_ROWS.filter(row=>row.path.includes('/host-run-usage/')||row.path.includes('/managed-review-evidence/')||row.path.includes('/canonical-new-story-artifacts/')||row.path.includes('/process-fact-contract/'))){
 const mutated=rows.map(row=>row.path===pin.path&&row.token===pin.token?{...row,count:row.count+1}:row);
 assert.ok(verifySchemaInventory(root,mutated).some(error=>error.includes(pin.path)&&error.includes(pin.token)),'extra schema occurrence remains rejected');rejected++;
}
console.log('MODULAR_SCHEMA_NEGATIVES_GREEN '+rejected);
