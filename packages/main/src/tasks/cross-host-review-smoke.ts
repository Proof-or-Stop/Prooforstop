#!/usr/bin/env node

/**
 * Cross-host review smoke (story B-f57a).
 *
 * RED phase: this asserts the `cross_host_review` command is registered. On the
 * pre-fix baseline the command does not exist, so `registry.get('cross_host_review')`
 * returns undefined and this assertion fails — an un-gameable proof that the
 * orchestration surface is missing.
 *
 * GREEN phase (this file): four cases driven by an INJECTED FAKE Codex seam — no
 * real CLI is ever spawned:
 *   (a) disagreement: fake emits a `fail` verdict with one finding NOT in host-A →
 *       recorded codex verdict decision==='fail', materialDigest===currentMaterialHash,
 *       jointDecision blocked, disagreement.onlyHostB.length===1.
 *   (b) fail-closed: fake emits no parseable JSON → host-B verdict decision==='blocked'
 *       with reason codex_review_no_parseable_verdict; result exposes stdoutDigest but
 *       NO raw-stdout field.
 *   (c) rebinding: fake emits a WRONG materialHash → blocked (material mismatch).
 *   (d) agreeing: identical findings, both pass → jointDecision pass, hasDisagreement false.
 * Plus a `host_verdict` process event with provider 'codex' must exist.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { resetConfigCache } from '../core/config.js';
import { currentMaterialHash } from '../core/evidence-freshness.js';
import { StoryStore } from '../core/store.js';
import { listVerdicts } from '../core/verdicts.js';
import { createMainRegistry } from '../registry.js';
import type { HandlerContext } from '../handlers/context.js';
import type { ChecklistData, StoryInfo } from '../core/types.js';
import type { Finding } from '../core/adversarial-review.js';
import {
  CODEX_REVIEW_VERDICT_SCHEMA,
  type CodexReviewRunner,
  type CodexReviewRunnerResult,
} from '../core/codex-review-leaf.js';
import {
  createCrossHostReviewHandlers,
  type CrossHostReviewResult,
} from '../handlers/cross-host-review.js';

const STORY_ID = 'B-xhr-smoke';
const REVIEW_ROUND = '2026-07-03T10:00:00.000Z';
const COMMIT_ENV = ['-c', 'user.email=xhr-smoke@example.test', '-c', 'user.name=Cross Host Review Smoke'];

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function write(root: string, path: string, content: string): void {
  const absolute = join(root, path);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, content, 'utf8');
}

function writeConfig(root: string): void {
  write(root, 'lattice.config.json', JSON.stringify({
    scanRoot: 'packages/main',
    rootDir: 'src',
    storyDir: '.lattice/story/actives',
    requirementsDir: 'docs/requirements',
    workflow: { profile: 'balanced' },
    proofAdmissibility: { mode: 'enforce', enforcedConsumers: ['REVIEW'] },
  }, null, 2) + '\n');
  resetConfigCache();
}

function story(): StoryInfo {
  return {
    storyId: STORY_ID,
    name: 'cross-host-review-smoke',
    title: 'cross_host_review smoke',
    description: 'Synthetic REVIEW story for cross_host_review smoke coverage.',
    type: 'feature',
    phase: 'REVIEW',
    priority: 'high',
    currentReviewRound: REVIEW_ROUND,
    riskSignals: [],
    createdAt: '2026-07-03T09:00:00.000Z',
    startedAt: '2026-07-03T09:10:00.000Z',
    endedAt: null,
    events: [{ phase: 'REVIEW', action: 'advance', timestamp: REVIEW_ROUND }],
  } as StoryInfo;
}

function checklist(): ChecklistData {
  return {
    items: [{
      id: 'CHK-001',
      title: 'auto-run codex review',
      context: 'Smoke fixture item already implemented.',
      status: 'done',
      startTime: null,
      endTime: null,
    }],
  };
}

function makeFixture(): { root: string; store: StoryStore; ctx: HandlerContext; registry: ReturnType<typeof createMainRegistry> } {
  const root = mkdtempSync(join(tmpdir(), 'lattice-xhr-smoke-'));
  writeConfig(root);
  write(root, 'README.md', 'cross host review smoke\n');
  write(root, 'packages/main/src/index.ts', 'export const seed = true;\n');
  git(root, ['init']);
  git(root, ['checkout', '-B', 'main']);
  git(root, ['add', '.']);
  git(root, [...COMMIT_ENV, 'commit', '-m', 'seed']);
  git(root, ['checkout', '-B', `story/${STORY_ID}`]);
  write(root, 'packages/main/src/index.ts', 'export const seed = true;\nexport const changed = 1;\n');
  git(root, ['add', 'packages/main/src/index.ts']);
  git(root, [...COMMIT_ENV, 'commit', '-m', 'story code change']);

  const store = new StoryStore(root);
  store.writeStory(STORY_ID, story());
  store.writeChecklist(STORY_ID, checklist());
  git(root, ['add', '.lattice/story', 'lattice.config.json']);
  git(root, [...COMMIT_ENV, 'commit', '-m', 'story review metadata']);

  const ctx: HandlerContext = { root, store, scanRoot: join(root, 'packages/main') };
  const registry = createMainRegistry(ctx);
  return { root, store, ctx, registry };
}

/** A fake seam that returns a canned stdout transcript wrapping a verdict JSON. */
function fakeSeam(stdout: string): CodexReviewRunner {
  return (): CodexReviewRunnerResult => ({ stdout, exitCode: 0, timedOut: false });
}

function verdictJsonStdout(materialHash: string, decision: 'pass' | 'fail' | 'blocked', findings: Finding[], summary: string): string {
  const verdict = { schemaVersion: CODEX_REVIEW_VERDICT_SCHEMA, decision, materialHash, findings, summary };
  // Wrap it in transcript noise to prove extraction pulls ONLY the final verdict object.
  return [
    'codex: reading additional input from stdin...',
    '{"type":"tool_log","message":"scanning packages/main/src/index.ts"}',
    'Here is my final verdict:',
    JSON.stringify(verdict, null, 2),
  ].join('\n');
}

let passed = 0;
function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  return Promise.resolve(fn()).then(() => {
    passed += 1;
    console.log(`  ✓ ${name}`);
  });
}

async function run(): Promise<void> {
  const previousCwd = process.cwd();
  const { root, store, ctx, registry } = makeFixture();
  try {
    process.chdir(root);

    // RED: the orchestration surface must be registered.
    assert.ok(registry.get('cross_host_review'), 'cross_host_review command must be registered');
    console.log('  ✓ cross_host_review is registered');
    passed += 1;

    const materialHash = currentMaterialHash(root, 'HEAD', root)!;
    assert.ok(materialHash, 'current material hash exists');

    const hostAFinding: Finding = {
      severity: 'MAJOR',
      title: 'Missing null check',
      file: 'packages/main/src/index.ts',
      line: 2,
      issue: 'changed is unchecked',
      fix: 'add a guard',
    };
    const hostBOnlyFinding: Finding = {
      severity: 'BLOCKER',
      title: 'Unbounded loop',
      file: 'packages/main/src/index.ts',
      line: 5,
      issue: 'loop never terminates',
      fix: 'bound the iteration',
    };
    const hostAFindingsFile = join(root, 'host-a-findings.json');

    // (a) DISAGREEMENT — fail verdict with a finding NOT in host-A.
    await check('(a) disagreement: fail verdict + host-B-only finding → blocked joint, onlyHostB=1', async () => {
      writeFileSync(hostAFindingsFile, JSON.stringify([hostAFinding], null, 2), 'utf8');
      const handlers = createCrossHostReviewHandlers(ctx, {
        codexRunner: fakeSeam(verdictJsonStdout(materialHash, 'fail', [hostBOnlyFinding], 'found a blocker')),
      });
      const result = await handlers.cross_host_review({
        storyId: STORY_ID,
        hostAFindingsFile,
        runId: `${STORY_ID}-xhr-a`,
        json: true,
      }) as CrossHostReviewResult;
      assert.equal(result.hostB.decision, 'fail', 'recorded codex verdict decision is fail');
      assert.equal(result.materialDigest, materialHash, 'result materialDigest === currentMaterialHash');
      assert.equal(result.jointDecision.jointDecision, 'blocked', 'joint decision blocked');
      assert.equal(result.disagreement.onlyHostB.length, 1, 'exactly one host-B-only finding');
      assert.equal(result.disagreement.hasDisagreement, true, 'disagreement flagged');
      assert.equal(result.disagreement.onlyHostA.length, 1, 'host-A finding not matched by host B');
      // The recorded codex verdict binds to materialDigest.
      const codexVerdicts = listVerdicts(root, 'local', STORY_ID).filter(v => v.runId === `${STORY_ID}-xhr-a` && v.provider === 'codex');
      assert.equal(codexVerdicts.length, 1, 'one codex verdict recorded');
      assert.equal(codexVerdicts[0].decision, 'fail', 'recorded codex verdict decision fail');
      assert.equal(codexVerdicts[0].materialDigest, materialHash, 'recorded codex verdict materialDigest binds to current material');
      // A host_verdict process event with provider 'codex' exists.
      const codexEvents = store.readProcessEvents(STORY_ID).filter(e => e.type === 'host_verdict' && (e as { provider?: string }).provider === 'codex');
      assert.ok(codexEvents.length >= 1, 'a host_verdict process event with provider codex exists');
    });

    // (b) FAIL-CLOSED — no parseable JSON.
    await check('(b) fail-closed: no parseable JSON → blocked with codex_review_no_parseable_verdict, no raw stdout', async () => {
      writeFileSync(hostAFindingsFile, JSON.stringify([], null, 2), 'utf8');
      const handlers = createCrossHostReviewHandlers(ctx, {
        codexRunner: fakeSeam('codex: I could not complete the review. No JSON here, just prose.'),
      });
      const result = await handlers.cross_host_review({
        storyId: STORY_ID,
        hostAFindingsFile,
        runId: `${STORY_ID}-xhr-b`,
        json: true,
      }) as CrossHostReviewResult;
      assert.equal(result.hostB.decision, 'blocked', 'host-B verdict blocked on unparseable output');
      assert.match(String(result.hostB.reason), /codex_review_no_parseable_verdict/, 'reason names codex_review_no_parseable_verdict');
      assert.equal(result.jointDecision.jointDecision, 'blocked', 'joint decision blocked (host B blocked)');
      // No raw-stdout field is surfaced anywhere on the result; only a stdoutDigest.
      assert.ok(typeof result.stdoutDigest === 'string' && /^[0-9a-f]{64}$/.test(result.stdoutDigest), 'stdoutDigest present as sha256');
      const serialized = JSON.stringify(result);
      assert.ok(!serialized.includes('could not complete the review'), 'raw stdout is never surfaced on the result');
      const asRecord = result as unknown as Record<string, unknown>;
      assert.equal(asRecord.stdout, undefined, 'no raw stdout field');
      assert.equal(asRecord.rawStdout, undefined, 'no rawStdout field');
    });

    // (c) REBINDING — wrong materialHash.
    await check('(c) rebinding: wrong materialHash → blocked (material mismatch)', async () => {
      writeFileSync(hostAFindingsFile, JSON.stringify([], null, 2), 'utf8');
      const handlers = createCrossHostReviewHandlers(ctx, {
        codexRunner: fakeSeam(verdictJsonStdout('deadbeef'.repeat(8), 'pass', [], 'looks fine to me')),
      });
      const result = await handlers.cross_host_review({
        storyId: STORY_ID,
        hostAFindingsFile,
        runId: `${STORY_ID}-xhr-c`,
        json: true,
      }) as CrossHostReviewResult;
      assert.equal(result.hostB.decision, 'blocked', 'host-B verdict blocked on material mismatch');
      assert.match(String(result.hostB.reason), /codex_review_material_mismatch/, 'reason names codex_review_material_mismatch');
      assert.equal(result.jointDecision.jointDecision, 'blocked', 'joint decision blocked');
    });

    // (d) AGREEING — identical findings, both pass → joint pass.
    await check('(d) agreeing: identical findings + both pass → joint pass, hasDisagreement false', async () => {
      // Both host A and host B raise the SAME (single) MINOR finding, so neither
      // decision is a fail and there is no finding-level divergence.
      const sharedFinding: Finding = {
        severity: 'MINOR',
        title: 'Style nit',
        file: 'packages/main/src/index.ts',
        line: 2,
        issue: 'prefer const',
        fix: 'use const',
      };
      writeFileSync(hostAFindingsFile, JSON.stringify([sharedFinding], null, 2), 'utf8');
      const handlers = createCrossHostReviewHandlers(ctx, {
        codexRunner: fakeSeam(verdictJsonStdout(materialHash, 'pass', [sharedFinding], 'agree, no blocker')),
      });
      const result = await handlers.cross_host_review({
        storyId: STORY_ID,
        hostAFindingsFile,
        runId: `${STORY_ID}-xhr-d`,
        json: true,
      }) as CrossHostReviewResult;
      assert.equal(result.hostA.decision, 'pass', 'host-A decision pass (only a MINOR finding)');
      assert.equal(result.hostB.decision, 'pass', 'host-B decision pass');
      assert.equal(result.disagreement.hasDisagreement, false, 'no disagreement on identical findings');
      assert.equal(result.disagreement.agreed.length, 1, 'the shared finding is agreed');
      assert.equal(result.jointDecision.jointDecision, 'pass', 'joint decision pass');
    });

    console.log(`\n✓ cross_host_review smoke passed (${passed} checks)`);
  } finally {
    process.chdir(previousCwd);
    rmSync(root, { recursive: true, force: true });
    resetConfigCache();
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
