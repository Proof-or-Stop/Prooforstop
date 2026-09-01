#!/usr/bin/env node
/**
 * B-3b88 CHK-001 smoke: verification_evidence_add / verification_evidence_batch_add
 * must refuse an evidence row whose `command` and `file` fields name contradictory
 * targets, without false-positiving on the many benign shapes. Covers all CHK-001
 * happy/edge/adversarial verification intents.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StoryStore } from '../core/store.js';
import { resetConfigCache } from '../core/config.js';
import type { ChecklistData, StoryInfo } from '../core/types.js';
import { createMainRegistry } from '../registry.js';
import type { HandlerContext } from '../handlers/context.js';

const STORY_ID = 'B-selfcheck';
const NOW = '2026-07-25T00:00:00.000Z';
const CONTRADICTION_RE = /contradict|targets|disagree/i;

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'evidence-selfcheck-smoke', GIT_AUTHOR_EMAIL: 'x@example.com',
      GIT_COMMITTER_NAME: 'evidence-selfcheck-smoke', GIT_COMMITTER_EMAIL: 'x@example.com',
    },
  }).trim();
}

function writeConfig(root: string): void {
  writeFileSync(join(root, 'proof-or-stop.config.json'), JSON.stringify({
    scanRoot: 'packages/main', rootDir: 'src', storyDir: '.proof-or-stop/story/actives',
    requirementsDir: 'docs/requirements', workflow: { profile: 'balanced' },
  }, null, 2) + '\n', 'utf8');
  resetConfigCache();
}

function baseStory(): StoryInfo {
  return {
    storyId: STORY_ID, name: 'evidence-selfcheck-smoke', title: 'contradiction guard fixture',
    description: 'Fixture story for the verification_evidence_add contradiction guard.',
    type: 'bug', phase: 'DEV', priority: 'medium', createdAt: NOW, startedAt: NOW, endedAt: null,
  };
}

function seed(): ChecklistData {
  return {
    items: [{
      id: 'CHK-001', title: 'contradiction guard item', context: 'evidence rows must not self-contradict',
      status: 'done', startTime: null, endTime: null,
      verificationIntent: {
        happy: [{ desc: 'h', type: 'logic', priority: 'must' }],
        edge: [{ desc: 'e', type: 'logic', priority: 'must' }],
        adversarial: [{ desc: 'a', type: 'logic', priority: 'must' }],
      },
      verificationEvidence: [],
    }],
  };
}

function createFixture(): HandlerContext {
  const root = mkdtempSync(join(tmpdir(), 'proof-or-stop-evidence-selfcheck-'));
  mkdirSync(join(root, 'packages/main/src'), { recursive: true });
  writeConfig(root);
  writeFileSync(join(root, 'README.md'), '# smoke\n', 'utf8');
  writeFileSync(join(root, 'packages/main/src/index.ts'), 'export const value = 1;\n', 'utf8');
  git(root, ['init']); git(root, ['checkout', '-b', 'main']);
  git(root, ['add', 'README.md', 'proof-or-stop.config.json', 'packages/main/src/index.ts']);
  git(root, ['commit', '-m', 'base']);
  const store = new StoryStore(root);
  store.writeStory(STORY_ID, baseStory());
  store.writeChecklist(STORY_ID, seed());
  return { store, root, scanRoot: join(root, 'packages/main') };
}

const ctx = createFixture();
const reg = createMainRegistry(ctx);
const add = reg.get('verification_evidence_add')!;
const batchAdd = reg.get('verification_evidence_batch_add')!;

let n = 0;
function row(over: Record<string, unknown>): Record<string, unknown> {
  // B-ec67 requires executable-intent evidence to carry a selector (mechanical
  // receipt) or a nonMechanicalReason. These synthetic rows exist only to exercise
  // the CHK-001 contradiction guard, so they are explicitly non-mechanical.
  return {
    storyId: STORY_ID, itemId: 'CHK-001', intentRef: 'CHK-001:happy:0', kind: 'logic_test',
    result: 'pass', note: `case ${++n} — contradiction guard scenario`,
    nonMechanicalReason: 'synthetic fixture row for the contradiction-guard unit smoke; not a mechanical proof',
    ...over,
  };
}
// B-ec67 made verification_evidence_add / _batch_add async (they may execute a
// pinned command), so refusals surface as rejected promises.
async function expectRefused(over: Record<string, unknown>, label: string): Promise<void> {
  await assert.rejects(async () => add(row(over)), CONTRADICTION_RE, label);
}
async function expectAccepted(over: Record<string, unknown>, label: string): Promise<void> {
  await assert.doesNotReject(async () => add(row(over)), label);
}

// happy:0 — F-049 reproduction: contradictory stems refused.
await expectRefused({ command: 'node packages/main/dist/tasks/gate-repeat-block-smoke.js', file: 'packages/main/src/tasks/convergence-breaker-smoke.ts' }, 'happy:0 F-049 contradictory');
// happy:1 — same stem across dist/src + .js/.ts accepted.
await expectAccepted({ command: 'node packages/main/dist/tasks/convergence-breaker-smoke.js', file: 'packages/main/src/tasks/convergence-breaker-smoke.ts' }, 'happy:1 same stem normalized');
// happy:2 — no-stem command + any file accepted.
await expectAccepted({ command: 'npm test', file: 'packages/main/src/tasks/foo.ts' }, 'happy:2 npm test no-stem');
// edge:0 — command with no file-like argument at all accepted.
await expectAccepted({ command: 'proof-or-stop validate', file: 'some-file.ts' }, 'edge:0 proof-or-stop validate no file-arg');
// edge:1 — command present, file absent accepted.
await expectAccepted({ command: 'node packages/main/dist/tasks/foo.js', file: undefined }, 'edge:1 command only');
// edge:2 — file present, command absent accepted.
await expectAccepted({ command: undefined, file: 'packages/main/src/tasks/foo.ts' }, 'edge:2 file only');
// edge:3 — same stem, .js vs .cjs accepted (normalized).
await expectAccepted({ command: 'node packages/main/dist/tasks/foo.js', file: 'packages/main/src/tasks/foo.cjs' }, 'edge:3 .js/.cjs same stem');
// edge:4 — multi-arg: last script arg (alpha) differs from file (beta) → refused, not the intermediate setup.js.
await expectRefused({ command: 'node --require setup.js packages/main/dist/tasks/alpha.js', file: 'packages/main/src/tasks/beta.ts' }, 'edge:4 multi-arg last target');
// adversarial:1 — shell pipe obfuscation: primary target A vs file B → refused.
await expectRefused({ command: 'node packages/main/dist/tasks/A.js | tee log', file: 'packages/main/src/tasks/B.ts' }, 'adversarial:1 shell pipe');
// adversarial:2 — path traversal in command: basename alpha vs file beta → refused.
await expectRefused({ command: 'node packages/main/dist/tasks/../tasks/alpha.js', file: 'packages/main/src/tasks/beta.ts' }, 'adversarial:2 path traversal');
// adversarial:3 — empty-string command + real file accepted without crashing.
await expectAccepted({ command: '', file: 'packages/main/src/tasks/foo.ts' }, 'adversarial:3 empty command no crash');

// adversarial:0 — batch_add with one contradictory entry must ALSO be refused (bypass closed).
await assert.rejects(
  async () => batchAdd({ storyId: STORY_ID, evidences: [
    { itemId: 'CHK-001', intentRef: 'CHK-001:edge:0', kind: 'logic_test', result: 'pass', note: 'batch benign entry ok', nonMechanicalReason: 'synthetic batch fixture row for the contradiction-guard unit smoke', command: 'npm test', file: 'packages/main/src/tasks/foo.ts' },
    { itemId: 'CHK-001', intentRef: 'CHK-001:adversarial:0', kind: 'logic_test', result: 'pass', note: 'batch contradictory entry must refuse', nonMechanicalReason: 'synthetic batch fixture row for the contradiction-guard unit smoke', command: 'node packages/main/dist/tasks/gate-repeat-block-smoke.js', file: 'packages/main/src/tasks/convergence-breaker-smoke.ts' },
  ] }),
  CONTRADICTION_RE,
  'adversarial:0 batch_add contradictory entry refused',
);

console.log('evidence-selfcheck-smoke: PASS');
