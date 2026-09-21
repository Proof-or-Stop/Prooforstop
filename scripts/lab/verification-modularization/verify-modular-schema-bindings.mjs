import assert from 'node:assert/strict';
import './../../../scripts/identity-cutover/bootstrap.mjs';
import {schemaRows} from '../../identity-cutover/schema-scan.mjs';
import {trackedFiles} from '../../identity-cutover/repository.mjs';
import {verifySchemaInventory} from '../../identity-cutover/source-integrity.mjs';
const root=process.cwd(),rows=schemaRows(root,trackedFiles(root));
assert.deepEqual(verifySchemaInventory(root,rows),[],'MODULAR_SCHEMA_BINDINGS_STALE: preserve schema occurrences across module paths');
console.log('MODULAR_SCHEMA_BINDINGS_GREEN '+JSON.stringify({rows:rows.length}));
