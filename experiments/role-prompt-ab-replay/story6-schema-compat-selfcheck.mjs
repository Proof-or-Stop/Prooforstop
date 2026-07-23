#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  assertClaudeSchemaEquivalent,
  deriveClaudeCompatibleSchema,
} from './lib/story6-schema-compat.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const canonical = JSON.parse(await readFile(path.join(here, 'story6-output.schema.json'), 'utf8'));
const claude = deriveClaudeCompatibleSchema(canonical);

assert.equal(Object.hasOwn(canonical, '$schema'), true, 'committed Codex schema keeps its dialect identity');
assert.equal(Object.hasOwn(claude, '$schema'), false, 'Claude argv omits only its unsupported dialect annotation');
assert.deepEqual(claude.required, ['findings', 'summary']);
assert.equal(claude.additionalProperties, false);
assert.equal(claude.properties.findings.items.additionalProperties, false);

const mutations = [
  schema => { schema.required = schema.required.filter(field => field !== 'findings'); },
  schema => { schema.additionalProperties = true; },
  schema => { schema.properties.findings.items.additionalProperties = true; },
  schema => { schema.properties.findings.items.required = schema.properties.findings.items.required.filter(field => field !== 'evidence'); },
];
for (const mutate of mutations) {
  const weakened = structuredClone(claude);
  mutate(weakened);
  assert.throws(
    () => assertClaudeSchemaEquivalent(canonical, weakened),
    /may differ .* only by removing root \$schema/,
  );
}

console.log(`story6-schema-compat-selfcheck: PASS (${mutations.length} schema weakening mutations rejected)`);
