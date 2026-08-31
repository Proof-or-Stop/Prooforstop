import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const distRoot = fileURLToPath(new URL('../dist/', import.meta.url));
const { resetConfigCache } = await import(join(distRoot, 'core/config.js'));
const { StoryStore } = await import(join(distRoot, 'core/store.js'));
const { createStoryCreateHandlers } = await import(join(distRoot, 'handlers/story-create.js'));

function write(root, path, content) {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
}

function validBackground() {
  return [
    '## Trigger Event',
    'F-080 guidance regression requires new stories to emit canonical reviewer IDs.',
    '',
    '## Key Insights',
    'Readers continue to accept intentional compatibility aliases, but active guidance must teach canonical IDs.',
    '',
    '## Solution Tradeoffs',
    'Keep the regression focused on story creation output and draft missing-check guidance.',
    '',
    '## Conversational Texture',
    'The resulting guidance should be directly usable by an implementer creating or reviewing a story.',
  ].join('\n');
}

const root = mkdtempSync(join(tmpdir(), 'proof-or-stop-f080-story-create-'));
try {
  write(root, 'proof-or-stop.config.json', JSON.stringify({
    scanRoot: 'packages/main',
    rootDir: 'src',
    storyDir: '.proof-or-stop/story/actives',
    requirementsDir: 'docs/requirements',
    storyPrefix: 'B',
  }));
  resetConfigCache();
  const store = new StoryStore(root);
  const handlers = createStoryCreateHandlers({ root, store, scanRoot: join(root, 'packages/main') });

  const output = handlers.story_create({
    name: 'f080-guidance',
    title: 'Canonical reviewer guidance',
    description: 'Ensure story creation emits canonical reviewer IDs.',
    type: 'chore',
    priority: 'medium',
    background: validBackground(),
    checklist: [{ title: 'Check reviewer guidance', context: 'Cover both active story-create guidance sites.' }],
    forceNew: true,
  });
  assert.match(output, /proof-or-stop-review-story-init/);
  assert.match(output, /proof-or-stop-product-reviewer/);
  assert.doesNotMatch(output, /subagent_type: "lattice-review-story-init"/);
  assert.doesNotMatch(output, /agentType":"lattice-review-story-init"/);
  assert.doesNotMatch(output, /subagent_type: "product-reviewer"/);
  assert.doesNotMatch(output, /agentType":"product-reviewer"/);

  const draftName = 'f080-missing-check';
  write(root, `docs/story/drafts/${draftName}/index.json`, JSON.stringify({
    title: 'Canonical draft guidance',
    description: 'Ensure missing draft-check guidance names the canonical reviewer.',
  }));
  write(root, `docs/story/drafts/${draftName}/background.md`, validBackground());
  write(root, `docs/story/drafts/${draftName}/checklist.json`, JSON.stringify({ items: [] }));
  assert.throws(
    () => handlers.story_create({ fromDraft: draftName }),
    (error) => {
      assert.match(error.message, /proof-or-stop-review-story-init/);
      assert.doesNotMatch(error.message, /lattice-review-story-init/);
      return true;
    },
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log('F-080 story-create canonical reviewer guidance test passed');
