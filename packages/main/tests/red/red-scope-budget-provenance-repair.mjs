import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { buildValidationCommandInventory } from '../../dist/core/validation-command-identity.js';

const root = resolve(import.meta.dirname, '../../../..');
const config = JSON.parse(readFileSync(resolve(root, 'proof-or-stop.config.json'), 'utf8'));
const inventory = buildValidationCommandInventory({ commands: config.validate.commands });
const knownIds = new Set(inventory.entries.map((entry) => entry.id));
const invalid = [];

for (const group of config.storyScopeBudget.validationGroups ?? []) {
  for (const commandId of group.commandIds ?? []) {
    if (!knownIds.has(commandId)) invalid.push(`${group.id}:${commandId}`);
  }
}

if (invalid.length > 0) {
  console.error(`SCOPE_BUDGET_PROVENANCE_RED ${invalid.join(',')}`);
  process.exit(1);
}

console.log('SCOPE_BUDGET_PROVENANCE_GREEN');
