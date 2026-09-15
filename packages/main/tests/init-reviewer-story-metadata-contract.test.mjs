import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const surfaces = [
  'packages/main/templates/agents/proof-or-stop-review-story-init.md',
  '.claude/agents/proof-or-stop-review-story-init.md',
  '.proof-or-stop-codex/agents/proof-or-stop-review-story-init.md',
];
const metadataQuery = `proof-or-stop story_get '{"storyId":"<storyId>","detail":true}'`;
const metadataFields =
  '`index.title` / `index.description` / `index.type` / `index.priority` / `index.riskSignals`';
const testName = 'test:init-reviewer-story-metadata-contract';

const packageJson = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
assert.equal(
  packageJson.scripts[testName],
  'node packages/main/tests/init-reviewer-story-metadata-contract.test.mjs',
  'the focused contract must have an exact root test command',
);
assert.equal(
  packageJson.scripts['test:serial-reference']
    .split(' && ')
    .filter((command) => command === `npm run ${testName}`).length,
  1,
  'the focused contract must run exactly once in the canonical serial suite',
);
assert.match(
  readFileSync(join(repoRoot, 'packages/main/src/tasks/full-suite-runner.ts'), 'utf8'),
  /repoRead\('test:init-reviewer-story-metadata-contract'\)/,
  'the focused contract must have a bounded full-suite resource policy',
);

for (const relativePath of surfaces) {
  const content = readFileSync(join(repoRoot, relativePath), 'utf8');
  assert.ok(
    content.includes(metadataQuery),
    `${relativePath} must request the detailed Story projection used by INIT review`,
  );
  assert.ok(
    content.includes(metadataFields),
    `${relativePath} must name the result.index metadata fields returned by story_get detail`,
  );
}

const canonicalTemplate = readFileSync(join(repoRoot, surfaces[0]), 'utf8');
const canonicalTemplateHash = createHash('sha256').update(canonicalTemplate).digest('hex');
assert.match(
  readFileSync(join(repoRoot, 'scripts/verify-proof-or-stop-prompt-baseline.mjs'), 'utf8'),
  new RegExp(
    `role: 'proof-or-stop-review-story-init',[\\s\\S]{0,120}` +
    `templateHash: '${canonicalTemplateHash}'`,
  ),
  'the independently reviewed prompt approval pin must match the canonical INIT template',
);

const [{ StoryStore }, { createStoryQueryHandlers }] = await Promise.all([
  import('../dist/core/store.js'),
  import('../dist/handlers/story-query.js'),
]);
const fixtureRoot = mkdtempSync(join(tmpdir(), 'init-reviewer-story-metadata-'));
try {
  const store = new StoryStore(fixtureRoot);
  store.writeStory('B-init', {
    storyId: 'B-init',
    name: 'init-reviewer-story-metadata',
    title: 'Review complete INIT Story metadata',
    description: 'The INIT reviewer needs the complete Story metadata projection before recording its independent assessment.',
    type: 'bug',
    phase: 'INIT',
    priority: 'high',
    riskSignals: [{ category: 'gate', matched: 'gate' }],
    createdAt: '2026-09-15T00:00:00.000Z',
    startedAt: null,
    endedAt: null,
  });
  store.writeChecklist('B-init', { items: [] });
  const handlers = createStoryQueryHandlers({ store, root: fixtureRoot, scanRoot: fixtureRoot });
  const defaultView = handlers.story_get({ storyId: 'B-init' });
  assert.equal(defaultView.index, undefined, 'default story_get output stays backward compatible');
  const detailView = handlers.story_get({ storyId: 'B-init', detail: true });
  assert.deepEqual(
    {
      title: detailView.index.title,
      description: detailView.index.description,
      type: detailView.index.type,
      priority: detailView.index.priority,
      riskSignals: detailView.index.riskSignals,
    },
    {
      title: 'Review complete INIT Story metadata',
      description: 'The INIT reviewer needs the complete Story metadata projection before recording its independent assessment.',
      type: 'bug',
      priority: 'high',
      riskSignals: [{ category: 'gate', matched: 'gate' }],
    },
  );
} finally {
  rmSync(fixtureRoot, { recursive: true, force: true });
}

console.log('INIT_REVIEWER_STORY_METADATA_CONTRACT_PASS');
