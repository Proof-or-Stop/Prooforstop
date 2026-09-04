import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const distRoot = fileURLToPath(new URL('../dist/', import.meta.url));
const { resetConfigCache } = await import(join(distRoot, 'core/config.js'));
const { StoryStore } = await import(join(distRoot, 'core/store.js'));
const { createChecklistHandlers } = await import(join(distRoot, 'handlers/checklist.js'));
const { createInitPreflightHandlers } = await import(join(distRoot, 'handlers/init-preflight.js'));
const { createStoryQueryHandlers } = await import(join(distRoot, 'handlers/story-query.js'));
const { buildDoneChecklist } = await import(join(distRoot, 'core/done-oracle.js'));
const { resolveReviewRunLane } = await import(join(distRoot, 'core/review-run.js'));
const { MAIN_TOOLS } = await import(join(distRoot, 'cli/command-catalog.js'));
const reviewerList = await import(join(distRoot, 'handlers/reviewer-list.js'));
const identity = await import(join(distRoot, 'core/agent-role-identity.js'));
const budget = await import(join(distRoot, 'core/prompt-budget.js'));

function write(root, path, content) {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
}

function initRoot(phase = 'INIT') {
  const root = mkdtempSync(join(tmpdir(), 'proof-or-stop-f081-f085-'));
  write(root, 'proof-or-stop.config.json', JSON.stringify({
    scanRoot: 'packages/main',
    rootDir: 'src',
    storyDir: '.proof-or-stop/story/actives',
    requirementsDir: 'docs/requirements',
    storyPrefix: 'B',
  }));
  mkdirSync(join(root, 'packages/main/src'), { recursive: true });
  write(root, 'packages/main/src/index.ts', 'export const boundarySmoke = true;\n');
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'canonical-role-test'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'canonical-role-test@example.local'], { cwd: root });
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', ['commit', '-qm', 'canonical role boundary baseline'], { cwd: root });
  resetConfigCache();
  const store = new StoryStore(root);
  const now = '2026-08-21T00:00:00.000Z';
  store.writeStory('B-boundary', {
    storyId: 'B-boundary',
    name: 'boundary',
    title: 'Canonical role boundary smoke',
    description: 'Verify canonical role output, guidance, and mutation guards.',
    type: 'chore',
    phase,
    priority: 'medium',
    createdAt: now,
    startedAt: now,
    endedAt: null,
    events: [],
  });
  store.writeChecklist('B-boundary', { items: [] });
  return { root, store };
}

// F-081: live roster output identifies the canonical role and its readable alias.
const reviewers = reviewerList.computeActiveReviewers(
  { riskSignals: [{ category: 'gate' }] },
  { items: [] },
  null,
  ['docs/README.md'],
);
const reviewerText = reviewerList.renderActiveReviewersText(reviewers);
assert.match(reviewerText, /proof-or-stop-review-quality \(legacy alias: lattice-review-quality\)/);
assert.match(reviewerText, /proof-or-stop-review-test-coverage \(legacy alias: lattice-review-test-coverage\)/);
assert.match(reviewerText, /proof-or-stop-review-behavior \(legacy alias: lattice-review-behavior\); riskSignal: gate/);
assert.equal(reviewers.find((reviewer) => reviewer.name === 'quality')?.lane, 'proof-or-stop-review-quality');

// F-082: CLI schema accepts canonical lanes and still reads the legacy spelling.
const reviewRunTool = MAIN_TOOLS.find((tool) => tool.name === 'review_run_start');
assert.ok(reviewRunTool, 'review_run_start is present in the command catalog');
for (const lane of [
  'proof-or-stop-review-quality',
  'proof-or-stop-review-delivery',
  'proof-or-stop-review-concept',
  'proof-or-stop-review-test-coverage',
  'lattice-review-quality',
]) {
  assert.equal(reviewRunTool.schema.lane.safeParse(lane).success, true, `${lane} is accepted by --lane schema`);
}
assert.equal(reviewRunTool.schema.lane.safeParse('proof-or-stop-review-unknown').success, false);
assert.equal(resolveReviewRunLane(undefined, 'proof-or-stop-review-quality'), 'proof-or-stop-review-quality');
assert.equal(resolveReviewRunLane(undefined, 'lattice-review-quality'), 'proof-or-stop-review-quality');

// F-083: canonical INIT reviewer identity receives the same mutation refusal as its alias.
const { root: guardRoot, store: guardStore } = initRoot();
const previousCwd = process.cwd();
try {
  process.chdir(guardRoot);
  const checklist = createChecklistHandlers({ root: guardRoot, store: guardStore, scanRoot: join(guardRoot, 'packages/main') });
  assert.throws(
    () => checklist.checklist_add({
      storyId: 'B-boundary',
      title: 'Unauthorized canonical scope change',
      context: 'The INIT reviewer must not mutate the checklist definition.',
      agent: 'proof-or-stop-review-story-init',
    }),
    /init_reviewer_checklist_mutation_blocked/,
  );
  const storyQuery = createStoryQueryHandlers({ root: guardRoot, store: guardStore, scanRoot: join(guardRoot, 'packages/main') });
  assert.throws(
    () => storyQuery.story_update({
      storyId: 'B-boundary',
      title: 'Unauthorized canonical title change',
      agent: 'proof-or-stop-review-story-init',
    }),
    /init_reviewer_story_scope_mutation_blocked/,
  );
  assert.equal(guardStore.readStory('B-boundary').title, 'Canonical role boundary smoke');
  assert.equal(guardStore.readChecklist('B-boundary').items.length, 0);
} finally {
  process.chdir(previousCwd);
  rmSync(guardRoot, { recursive: true, force: true });
}

// F-084: active recovery/next-step output teaches canonical reviewer IDs.
const { root: initRootPath, store: initStore } = initRoot('INIT');
try {
  const preflight = createInitPreflightHandlers({ root: initRootPath, store: initStore, scanRoot: join(initRootPath, 'packages/main') });
  const output = preflight.init_preflight({ storyId: 'B-boundary' });
  assert.match(output, /proof-or-stop-review-story-init/);
  assert.match(output, /proof-or-stop-product-reviewer/);
  assert.doesNotMatch(output, /lattice-review-story-init/);
  assert.doesNotMatch(output, /product-reviewer \+ lattice-review/);
} finally {
  rmSync(initRootPath, { recursive: true, force: true });
}

const { root: doneRoot, store: doneStore } = initRoot('TEST');
try {
  const deliveryRow = buildDoneChecklist('B-boundary', doneStore, doneRoot).find((row) => row.id === 'delivery-check');
  assert.ok(deliveryRow, 'DONE oracle exposes delivery-check row');
  assert.match(deliveryRow.hint, /proof-or-stop-review-delivery/);
  assert.doesNotMatch(deliveryRow.hint, /lattice-review-delivery/);
} finally {
  rmSync(doneRoot, { recursive: true, force: true });
}

// F-085: canonical and legacy callers produce the same normalized budget observation.
assert.equal(identity.canonicalAgentRoleId('lattice-implementer'), 'proof-or-stop-implementer');
assert.equal(budget.isBudgetedComplexRole('proof-or-stop-implementer'), true);
assert.equal(budget.isBudgetedComplexRole('lattice-implementer'), true);
assert.deepEqual(
  budget.observeComplexRolePromptBudget({ roleId: 'lattice-review-delivery', contextMode: 'full', bytes: 100, estimatedTokens: 25 }),
  budget.observeComplexRolePromptBudget({ roleId: 'proof-or-stop-review-delivery', contextMode: 'full', bytes: 100, estimatedTokens: 25 }),
);

console.log('F-081..F-085 canonical role boundary tests passed');
