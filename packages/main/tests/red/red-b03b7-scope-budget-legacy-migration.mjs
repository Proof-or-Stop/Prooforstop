import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';

import { readScopeBudgetLegacySnapshot } from '../../dist/core/story-scope-budget-legacy.js';
import { StoryStore } from '../../dist/core/store.js';

const storyRoot = resolve(process.argv[2] || '');
if (!process.argv[2]) {
  console.error('BROKEN: expected the B-03b7 worktree path');
  process.exit(2);
}

const store = new StoryStore(storyRoot);
const snapshot = readScopeBudgetLegacySnapshot(store, 'B-03b7');
const labRoot = resolve(import.meta.dirname, '../../../..');
const config = JSON.parse(readFileSync(resolve(labRoot, 'proof-or-stop.config.json'), 'utf8'));
const entry = config.storyScopeBudget?.legacySubjects?.entries?.find(
  (candidate) => candidate.storyId === 'B-03b7' && candidate.createdAt === snapshot.createdAt,
);

if (!snapshot.eligibleForMigration || entry?.subjectDigest !== snapshot.subjectDigest) {
  console.error('B03B7_SCOPE_BUDGET_MIGRATION_RED missing exact eligible legacy-subject binding');
  process.exit(1);
}

console.log('B03B7_SCOPE_BUDGET_MIGRATION_GREEN');
