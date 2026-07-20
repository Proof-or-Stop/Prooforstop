import { canonicalJsonStringify } from '../../../packages/main/dist/core/prompt-contracts.js';

export function assertClaudeSchemaEquivalent(canonicalSchema, claudeSchema) {
  if (!canonicalSchema || typeof canonicalSchema !== 'object' || Array.isArray(canonicalSchema)) {
    throw new Error('committed output schema must be a JSON object');
  }
  if (canonicalSchema.$schema !== 'https://json-schema.org/draft/2020-12/schema') {
    throw new Error('committed output schema must retain the pinned draft-2020-12 identity');
  }
  if (Object.hasOwn(claudeSchema, '$schema')) {
    throw new Error('Claude-compatible schema must omit the unsupported root $schema annotation');
  }
  const expected = structuredClone(canonicalSchema);
  delete expected.$schema;
  if (canonicalJsonStringify(claudeSchema) !== canonicalJsonStringify(expected)) {
    throw new Error('Claude-compatible schema may differ from the committed schema only by removing root $schema');
  }
}

export function deriveClaudeCompatibleSchema(canonicalSchema) {
  const derived = structuredClone(canonicalSchema);
  delete derived.$schema;
  assertClaudeSchemaEquivalent(canonicalSchema, derived);
  return derived;
}
