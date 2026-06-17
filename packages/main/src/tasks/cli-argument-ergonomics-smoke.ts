import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { MAIN_TOOLS, parseFlags } from '../cli-engine.js';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cliPath = join(packageRoot, 'cli.js');

function schemaFor(name: string) {
  const tool = MAIN_TOOLS.find(t => t.name === name);
  assert.ok(tool, `missing tool schema: ${name}`);
  return z.object(tool.schema);
}

const relatedDocsFlags = parseFlags(
  ['--storyId=B-smoke', '--itemId=CHK-001', '--relatedDocs=["AGENTS.md","CLAUDE.md"]'],
  MAIN_TOOLS.find(t => t.name === 'checklist_update')!.schema,
);
assert.deepEqual(relatedDocsFlags.relatedDocs, ['AGENTS.md', 'CLAUDE.md']);
assert.equal(schemaFor('checklist_update').safeParse(relatedDocsFlags).success, true);

const repeatedRelatedDocsFlags = parseFlags(
  ['--storyId=B-smoke', '--itemId=CHK-001', '--relatedDocs=AGENTS.md', '--relatedDocs=CLAUDE.md'],
  MAIN_TOOLS.find(t => t.name === 'checklist_update')!.schema,
);
assert.deepEqual(repeatedRelatedDocsFlags.relatedDocs, ['AGENTS.md', 'CLAUDE.md']);
assert.equal(schemaFor('checklist_update').safeParse(repeatedRelatedDocsFlags).success, true);

const storyCreate = schemaFor('story_create').parse({
  name: 'test-type-alias',
  title: 'Test type alias',
  description: 'A validation-only story should not force users to guess chore.',
  type: 'test',
  priority: 'medium',
  background: [
    '## Trigger Event',
    '2026-05-03 User feedback: validation-type stories using type test are rejected, forcing users to guess the chore type when first creating a validation task.',
    '',
    '## Key Insight',
    'Validation-type tasks are semantically closer to chore in Lattice, but users naturally type test; the CLI should absorb this common expression difference.',
    '',
    '## Trade-off Decision',
    'Keep the persisted StoryType set unchanged, and only normalize test to chore at the CLI schema layer to avoid breaking downstream type checks.',
    '',
    '## Conversation Texture',
    'The user hit this limitation while validating framework behavior, expecting the command to proceed rather than first having to learn the internal four-category enum boundary.',
  ].join('\n'),
});
assert.equal(storyCreate.type, 'chore');

const emptyVerificationIntent = schemaFor('checklist_update').parse({
  storyId: 'B-smoke',
  itemId: 'CHK-001',
  verificationIntent: {},
});
assert.deepEqual(emptyVerificationIntent.verificationIntent, {
  happy: [],
  edge: [],
  adversarial: [],
});

const isolatedCwd = mkdtempSync(join(tmpdir(), 'lattice-cli-arg-smoke-'));
try {
  const env = { ...process.env };
  delete env.LATTICE_PROJECT_ROOT;
  const invalidVerificationIntent = spawnSync(process.execPath, [
    cliPath,
    'checklist_update',
    JSON.stringify({
      storyId: 'B-smoke',
      itemId: 'CHK-001',
      verificationIntent: {
        happy: [{ desc: 'bad enum', type: 'integration_test', priority: 'must' }],
      },
    }),
  ], {
    cwd: isolatedCwd,
    env,
    encoding: 'utf-8',
  });
  assert.notEqual(invalidVerificationIntent.status, 0, 'invalid verificationIntent enum should fail');
  assert.match(invalidVerificationIntent.stderr, /Argument validation failed/);
  assert.match(invalidVerificationIntent.stderr, /verificationIntent\.happy\.0\.type/);
  assert.match(invalidVerificationIntent.stderr, /integration_test/);
  assert.match(invalidVerificationIntent.stderr, /logic[\s\S]*cli[\s\S]*browser[\s\S]*manual[\s\S]*docs/);
  assert.match(invalidVerificationIntent.stderr, /Argument validation failed \(summary\)/);
  assert.doesNotMatch(invalidVerificationIntent.stderr, /Command "checklist_update" is not available in .* phase/);
  assert.doesNotMatch(invalidVerificationIntent.stdout, /Don't know what to do now|lattice status/);
} finally {
  rmSync(isolatedCwd, { recursive: true, force: true });
}

console.log('cli argument ergonomics smoke passed');
