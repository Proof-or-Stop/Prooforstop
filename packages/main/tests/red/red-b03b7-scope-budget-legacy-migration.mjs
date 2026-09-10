import { resolve } from 'node:path';

import { readStoryScopeBudget } from '../../dist/core/story-scope-budget.js';
import { StoryStore } from '../../dist/core/store.js';

const storyRoot = resolve(process.argv[2] || '');
if (!process.argv[2]) {
  console.error('BROKEN: expected the B-03b7 worktree path');
  process.exit(2);
}

const store = new StoryStore(storyRoot);
const report = readStoryScopeBudget(store, resolve(import.meta.dirname, '../../../..'), 'B-03b7');

if (report.status !== 'legacy_subject_preserved' || report.blocking) {
  console.error(`B03B7_SCOPE_BUDGET_MIGRATION_RED status=${report.status} blocking=${report.blocking}`);
  process.exit(1);
}

console.log('B03B7_SCOPE_BUDGET_MIGRATION_GREEN');
