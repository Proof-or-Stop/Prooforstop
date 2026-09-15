import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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

console.log('INIT_REVIEWER_STORY_METADATA_CONTRACT_PASS');
