import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { acquireOwnerLease } from '../dist/core/story-owner-lease.js';
import { resetConfigCache } from '../dist/core/config.js';
import { StoryStore } from '../dist/core/store.js';
import { createChecklistHandlers } from '../dist/handlers/checklist.js';

const source = readFileSync(new URL('../src/handlers/checklist.ts', import.meta.url), 'utf8');
const probeStart = source.indexOf('function probeCausalPreflightFacts');
const probeEnd = source.indexOf('/**\n * B-2296', probeStart);
const enforcementStart = source.indexOf('const preflightInput');
const enforcementEnd = source.indexOf('const exitOk =', enforcementStart);
const batchStart = source.indexOf('async verification_evidence_batch_add');
const batchEnd = source.indexOf('async verification_run', batchStart);

assert.ok(probeStart >= 0 && probeEnd > probeStart, 'the handler must retain one complete causal probe');
const probeSource = source.slice(probeStart, probeEnd);
for (const fact of [
  'cli', 'worktree', 'gitIndex', 'gitMaterial', 'writerLease',
  'providerCapability', 'resources', 'evidenceTarget', 'sideChannel',
]) {
  assert.match(probeSource, new RegExp(`\\b${fact}\\b`), `probe includes ${fact}`);
}
const gitIndexStart = source.indexOf('function probeGitIndex');
assert.ok(gitIndexStart >= 0 && probeStart > gitIndexStart, 'the handler must retain the git index probe');
assert.match(source.slice(gitIndexStart, probeStart), /contentDigest/, 'gitIndex probe includes a content identity digest');

assert.ok(enforcementStart >= 0 && enforcementEnd > enforcementStart, 'the handler must retain the causal execution seam');
const enforcementSource = source.slice(enforcementStart, enforcementEnd);
assert.match(enforcementSource, /causalCanonical\(deps\.preflightFacts\(preflightInput\)\)/,
  'last-moment revalidation compares the complete probe-fact snapshot');
assert.match(enforcementSource, /revalidateBeforeRun: preflightFactsUnchanged/,
  'the full probe revalidation is wired to the child-launch boundary');
assert.doesNotMatch(enforcementSource, /current\.headHash === hashes\.headHash/,
  'the child-launch boundary must not regress to hash-only revalidation');

assert.ok(batchStart >= 0 && batchEnd > batchStart, 'the production batch handler must be present');
const batchSource = source.slice(batchStart, batchEnd);
assert.match(batchSource, /deriveCausalMetrics\(causalBatch\.ledger\)/,
  'the production batch response derives metrics from its causal ledger');
assert.match(batchSource, /renderCausalMetrics\(deriveCausalMetrics\(causalBatch\.ledger\)\)/,
  'the production batch response renders the derived causal metrics');

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}

function write(root, relativePath, content) {
  const target = join(root, relativePath);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content);
}

const root = mkdtempSync(join(tmpdir(), 'proof-or-stop-causal-batch-'));
try {
  write(root, 'proof-or-stop.config.json', JSON.stringify({
    scanRoot: 'packages/main',
    rootDir: 'src',
    storyDir: '.proof-or-stop/story/actives',
    requirementsDir: 'docs/requirements',
  }));
  write(root, 'packages/main/package.json', JSON.stringify({ name: '@proof-or-stop/core', version: '0.3.266' }));
  write(root, 'packages/main/src/base.ts', 'export const base = true;\n');
  git(root, ['init', '-b', 'main']);
  git(root, ['config', 'user.email', 'causal-batch@example.test']);
  git(root, ['config', 'user.name', 'Causal Batch Test']);
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'seed']);

  resetConfigCache();
  const store = new StoryStore(root);
  const storyId = 'B-causal-batch';
  const intents = Array.from({ length: 58 }, (_, index) => ({
    id: `INT-${index}`,
    desc: `causal batch intent ${index}`,
    type: 'cli',
    priority: 'must',
  }));
  store.writeStory(storyId, {
    storyId,
    name: 'causal-batch',
    title: 'causal batch response metrics',
    description: 'focused causal batch response test',
    type: 'chore',
    phase: 'DEV',
    priority: 'medium',
    createdAt: '2026-08-20T00:00:00.000Z',
    startedAt: '2026-08-20T00:00:00.000Z',
    endedAt: null,
  });
  store.writeChecklist(storyId, {
    items: [{
      id: 'CHK-001',
      title: 'causal batch',
      context: 'focused handler response test',
      status: 'in_progress',
      startTime: null,
      endTime: null,
      verificationIntent: { happy: intents, edge: [], adversarial: [] },
    }],
  });
  acquireOwnerLease(store.storyDirPath(storyId), {
    command: 'verification_evidence_batch_add',
    cwd: root,
  });

  const handlers = createChecklistHandlers({ store, root, scanRoot: join(root, 'packages/main') });
  const commands = Array.from({ length: 10 }, (_, index) =>
    `node -e "console.log('CAUSAL_BATCH_OK'); void ${index}"`,
  );
  const response = await handlers.verification_evidence_batch_add({
    storyId,
    evidences: intents.map((intent, index) => ({
      itemId: 'CHK-001',
      intentRef: intent.id,
      kind: 'integration_test',
      command: commands[index % commands.length],
      selector: 'CAUSAL_BATCH_OK',
      result: 'pass',
      note: `executed causal batch intent ${index}`,
    })),
  });

  assert.match(response, /Verification evidence batch recorded for B-causal-batch: 58 item intent/);
  assert.match(response, /CausalEvidence: intentCount=58 uniqueExecutionKeys=10 commandExecutions=10 cacheHitRate=83%/,
    'the response uses source arithmetic: (58 - 10) / 58 rounds to 83%');
  assert.equal((((58 - 10) / 58) * 100).toFixed(2), '82.76',
    'the unrounded cache hit rate is 82.76%; the displayed 83% is presentation rounding');
  const displayedRate = Number(response.match(/cacheHitRate=(\d+)%/)?.[1]);
  assert.ok(displayedRate >= 80, 'the displayed causal cache hit rate satisfies the semantic >=80% contract');

  const raceRoot = mkdtempSync(join(tmpdir(), 'proof-or-stop-causal-preflight-race-'));
  try {
    write(raceRoot, 'proof-or-stop.config.json', JSON.stringify({
      scanRoot: 'packages/main',
      rootDir: 'src',
      storyDir: '.proof-or-stop/story/actives',
      requirementsDir: 'docs/requirements',
    }));
    write(raceRoot, 'packages/main/package.json', JSON.stringify({ name: '@proof-or-stop/core', version: '0.3.266' }));
    write(raceRoot, 'packages/main/src/base.ts', 'export const base = true;\n');
    git(raceRoot, ['init', '-b', 'main']);
    git(raceRoot, ['config', 'user.email', 'causal-preflight@example.test']);
    git(raceRoot, ['config', 'user.name', 'Causal Preflight Test']);
    git(raceRoot, ['add', '.']);
    git(raceRoot, ['commit', '-m', 'seed']);

    resetConfigCache();
    const raceStore = new StoryStore(raceRoot);
    const raceStoryId = 'B-causal-preflight-race';
    raceStore.writeStory(raceStoryId, {
      storyId: raceStoryId,
      name: 'causal-preflight-race',
      title: 'causal preflight race refusal',
      description: 'focused handler preflight race test',
      type: 'chore',
      phase: 'DEV',
      priority: 'medium',
      createdAt: '2026-08-20T00:00:00.000Z',
      startedAt: '2026-08-20T00:00:00.000Z',
      endedAt: null,
    });
    raceStore.writeChecklist(raceStoryId, {
      items: [{
        id: 'CHK-001',
        title: 'causal preflight race',
        context: 'refuse a changed preflight snapshot before launch',
        status: 'in_progress',
        startTime: null,
        endTime: null,
        verificationIntent: {
          happy: [{ id: 'INT-001', desc: 'causal preflight race', type: 'cli', priority: 'must' }],
          edge: [],
          adversarial: [],
        },
      }],
    });
    acquireOwnerLease(raceStore.storyDirPath(raceStoryId), {
      command: 'verification_evidence_add',
      cwd: raceRoot,
    });

    let preflightCalls = 0;
    const launchMarker = join(raceRoot, 'child-launched');
    const causalFacts = (contentDigest) => ({
      cli: { available: true, path: process.execPath },
      worktree: { expected: raceRoot, actual: raceRoot },
      gitIndex: { readable: true, path: join(raceRoot, '.git', 'index'), contentDigest },
      gitMaterial: { available: true, headHash: 'head', materialHash: 'material', storyFilesHash: 'story-files' },
      writerLease: { available: true, valid: true },
      providerCapability: {
        required: ['allowlisted-command', 'bounded-output'],
        available: ['allowlisted-command', 'bounded-output'],
      },
      resources: { required: { timeoutMs: 1000 }, available: { timeoutMs: 1000 } },
      evidenceTarget: { writable: true, path: join(raceRoot, '.proof-or-stop', 'causal-receipts'), probe: 'test' },
      sideChannel: { available: true, maxOutputChars: 1000, maxProgressEvents: 1 },
    });
    const raceHandlers = createChecklistHandlers({
      store: raceStore,
      root: raceRoot,
      scanRoot: join(raceRoot, 'packages/main'),
      causalPreflightFacts: () => {
        preflightCalls++;
        return causalFacts(preflightCalls === 1 ? 'sha256:index-before' : 'sha256:index-after');
      },
    });

    await assert.rejects(
      raceHandlers.verification_evidence_add({
        storyId: raceStoryId,
        itemId: 'CHK-001',
        intentRef: 'INT-001',
        kind: 'integration_test',
        command: `node -e "require('node:fs').writeFileSync('${launchMarker}', 'launched'); console.log('CAUSAL_RACE_OK')"`,
        selector: 'CAUSAL_RACE_OK',
        result: 'pass',
        note: 'changed index digest refusal',
      }),
      /state_changed_before_launch.*commandExecutions=0 evidenceWrites=0/,
      'a changed second preflight snapshot is refused before the pinned child launch',
    );
    assert.equal(preflightCalls, 2, 'the handler observes the changed second preflight snapshot');
    assert.equal(existsSync(launchMarker), false, 'the refused preflight launches no child command');
    const raceItem = raceStore.readChecklist(raceStoryId).items[0];
    assert.equal(raceItem.verificationEvidence?.length ?? 0, 0, 'the refused preflight records no evidence');
    assert.equal(raceItem.verificationIntent?.happy?.[0]?.verification, undefined, 'the refused preflight records no pin');
  } finally {
    rmSync(raceRoot, { recursive: true, force: true });
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log('checklist-causal-preflight-batch: PASS');
