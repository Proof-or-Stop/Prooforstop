/**
 * Documentation that describes the changed behavior is part of delivering it.
 * On the abs benchmark (run 10) the delivery reviewer required a docs example
 * to be updated, the scope contract had no docs path, and the only way to widen
 * scope after PLAN (acceptance_amendment_propose) needs a ProofStory contract
 * the Story never had, so the owner was forced back to PLAN and timed out.
 * Docs files are admitted by default; protected/excluded patterns still win,
 * and code, config and test files stay fail-closed.
 */
import assert from 'node:assert/strict';
import { classifyScopePath } from '../core/scope-path-classifier.js';

const contract = {
  storyId: 'B-docs',
  allowedModify: ['evaluator/evaluator.go'],
  allowedCreate: [],
  allowedTest: ['evaluator/evaluator_test.go'],
  protectedFiles: ['docs/protected.md'],
  explicitExcludes: ['docs/excluded/**'],
};

for (const path of ['docs/types/string.md', 'README.md', 'docs/guide.rst', 'site/page.mdx']) {
  assert.equal(classifyScopePath(contract, path).allowed, true, `${path} documents the change and is admitted`);
}
assert.equal(classifyScopePath(contract, 'docs/protected.md').allowed, false, 'protectedFiles still wins over the docs default');
assert.equal(classifyScopePath(contract, 'docs/excluded/a.md').allowed, false, 'explicitExcludes still wins over the docs default');
for (const path of ['parser/parser.go', 'docs/build.sh', 'Makefile', 'config.yaml', 'README.md.go']) {
  assert.equal(classifyScopePath(contract, path).allowed, false, `${path} is not documentation and stays fail-closed`);
}
console.log('docs-scope-default-smoke: PASS');
