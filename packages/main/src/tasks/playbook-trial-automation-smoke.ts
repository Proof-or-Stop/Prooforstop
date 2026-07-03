#!/usr/bin/env node
/**
 * @task B-5f5b
 * @checklist CHK-002
 * @title playbook trial and timer automation smoke
 * @type feature
 * @priority high
 * @description
 *   Proves candidate trial automation writes only unknown candidate exposures
 *   plus matched controls, is idempotent, skips active playbooks, and the
 *   bounded timer cannot activate candidates that lack helped evidence.
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { READ_ONLY_COMMANDS } from '../cli/activity-policy.js';
import { MAIN_TOOLS } from '../cli-engine.js';
import { COMMAND_POLICIES } from '../core/command-policy.js';
import { isCommandAllowed } from '../core/config.js';
import type { Playbook } from '../core/experience-layer-types.js';
import type {
  PlaybookPromotionTimerReport,
  PlaybookTrialRunReport,
} from '../core/playbook-seed.js';
import {
  readPlaybookAutoActivationEvents,
  readPlaybookOutcomeEvents,
  readPlaybookTrialControlEvents,
  readPlaybooks,
  writePlaybooks,
} from '../core/learning-store.js';
import { PROCESS_FACT_LEVELS } from '../core/process-fact-levels.js';
import { StoryStore } from '../core/store.js';
import type { StoryInfo } from '../core/types.js';
import type { HandlerContext } from '../handlers/context.js';
import { createMainRegistry, type Registry } from '../registry.js';

const NOW = '2026-07-03T01:00:00.000Z';
const STORY_ID = 'B-trial';

let total = 0;
let passed = 0;

function check(label: string, fn: () => void): void {
  total += 1;
  try {
    fn();
    passed += 1;
    console.log(`check: ${label} - PASS`);
  } catch (err) {
    console.error(`check: ${label} - FAIL`);
    console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
    process.exitCode = 1;
  }
}

function write(root: string, rel: string, content: string): void {
  const file = join(root, rel);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content, 'utf8');
}

function mkProject(): { root: string; store: StoryStore } {
  const root = mkdtempSync(join(tmpdir(), 'b5f5b-trial-automation-'));
  write(root, 'lattice.config.json', JSON.stringify({
    scanRoot: 'packages/main',
    rootDir: 'src',
    storyDir: '.lattice/story/actives',
    requirementsDir: 'docs/requirements',
  }, null, 2));
  return { root, store: new StoryStore(root) };
}

function mkRegistry(root: string, store: StoryStore): Registry {
  const ctx: HandlerContext = { root, store, scanRoot: join(root, 'packages/main'), log: () => {} };
  return createMainRegistry(ctx);
}

function runJson<T>(registry: Registry, name: string, args: Record<string, unknown>): T {
  const handler = registry.get(name);
  assert.ok(handler, `registry includes ${name}`);
  return JSON.parse(String(handler(args))) as T;
}

function runText(registry: Registry, name: string, args: Record<string, unknown>): string {
  const handler = registry.get(name);
  assert.ok(handler, `registry includes ${name}`);
  return String(handler(args));
}

function story(): StoryInfo {
  return {
    storyId: STORY_ID,
    name: STORY_ID,
    title: 'Trial candidate playbooks',
    description: 'Synthetic trial/timer smoke story.',
    type: 'feature',
    phase: 'REVIEW',
    priority: 'medium',
    createdAt: NOW,
    startedAt: NOW,
    endedAt: null,
    events: [{ phase: 'REVIEW', action: 'advance', timestamp: NOW }],
  };
}

function playbook(id: string, status: Playbook['status'], keyword: string): Playbook {
  return {
    id,
    title: `${keyword} playbook`,
    trigger: {
      keywords: [keyword, 'trial', 'automation'],
      fileKinds: ['ts'],
      storyPhases: ['REVIEW'],
    },
    check: `Check ${keyword} before final claims.`,
    pitfalls: [`${keyword} must remain non-authoritative.`],
    verification: [`Verify ${keyword} is advisory only.`],
    lineage: {
      sourceStoryId: STORY_ID,
      sourceFindingId: `${STORY_ID}:F-${id}`,
      sourceSignature: keyword,
    },
    status,
    usage: { surfacedCount: 0, resolvedHits: 0, dismissedHits: 0 },
  };
}

function seed(root: string, store: StoryStore): void {
  store.writeStory(STORY_ID, story());
  store.writeChecklist(STORY_ID, { items: [] });
  store.writeFindings(STORY_ID, { findings: [] });
  writePlaybooks(root, [
    playbook('PBP-101', 'candidate', 'candidate-one'),
    playbook('PBP-102', 'candidate', 'candidate-two'),
    playbook('PBP-999', 'active', 'active-skip'),
  ]);
}

const roots: string[] = [];

try {
  check('trial writes unknown candidate exposure and matched control idempotently', () => {
    const { root, store } = mkProject();
    roots.push(root);
    seed(root, store);
    const registry = mkRegistry(root, store);

    const dryRun = runJson<PlaybookTrialRunReport>(registry, 'playbook_trial_run', {
      storyId: STORY_ID,
      apply: false,
      limit: 1,
      json: true,
    });
    assert.equal(dryRun.dryRun, true);
    assert.equal(dryRun.selectedCount, 1);
    assert.equal(readPlaybookOutcomeEvents(root).length, 0);
    assert.equal(readPlaybookTrialControlEvents(root).length, 0);

    const applied = runJson<PlaybookTrialRunReport>(registry, 'playbook_trial_run', {
      storyId: STORY_ID,
      apply: true,
      limit: 1,
      json: true,
    });
    assert.equal(applied.outcomeCreatedCount, 1);
    assert.equal(applied.controlCreatedCount, 1);
    assert.equal(applied.skippedNonCandidateCount, 1);
    const outcomes = readPlaybookOutcomeEvents(root);
    assert.equal(outcomes.length, 1);
    assert.equal(outcomes[0].playbookStatusAtObservation, 'candidate');
    assert.equal(outcomes[0].exposureMode, 'candidate-inspection');
    assert.equal(outcomes[0].outcome.verdict, 'unknown');
    assert.equal(outcomes[0].outcome.verdictSource, 'candidate-trial');
    assert.equal(outcomes[0].outcome.causedNoise, false);
    assert.equal(outcomes[0].outcome.causedWrongClaim, false);
    assert.equal(outcomes[0].outcome.preventedRepeatFinding, false);
    assert.equal(outcomes.some((event) => event.playbookId === 'PBP-999'), false, 'active playbook is not trialed');

    const controls = readPlaybookTrialControlEvents(root);
    assert.equal(controls.length, 1);
    assert.equal(controls[0].control.exposureMode, 'none');
    assert.equal(controls[0].control.verdict, 'unknown');
    assert.equal(controls[0].control.verdictSource, 'matched-control');

    const status = runJson<any>(registry, 'playbook_promotion_status', { json: true });
    assert.equal(status.trialControlSummary.outcomeTrialExposureRows, 1);
    assert.equal(status.trialControlSummary.matchedControlRows, 1);
    assert.equal(status.trialControlSummary.malformedControlRows, 0);
    assert.deepEqual(status.trialControlSummary.perPlaybook, [{
      playbookId: 'PBP-101',
      outcomeTrialExposureRows: 1,
      matchedControlRows: 1,
    }]);
    assert.equal(typeof status.paths.trialControls, 'string');
    const statusText = runText(registry, 'playbook_promotion_status', {});
    assert.match(statusText, /^trialControlSummary\.outcomeTrialExposureRows: 1$/m);
    assert.match(statusText, /^trialControlSummary\.matchedControlRows: 1$/m);
    assert.match(statusText, /PBP-101 outcomeTrialExposureRows=1 matchedControlRows=1/);

    const repeat = runJson<PlaybookTrialRunReport>(registry, 'playbook_trial_run', {
      storyId: STORY_ID,
      apply: true,
      limit: 1,
      json: true,
    });
    assert.equal(repeat.outcomeCreatedCount, 0);
    assert.equal(repeat.controlCreatedCount, 0);
    assert.equal(repeat.outcomeAlreadyExistsCount, 1);
    assert.equal(repeat.controlAlreadyExistsCount, 1);
    assert.equal(readPlaybookOutcomeEvents(root).length, 1);
    assert.equal(readPlaybookTrialControlEvents(root).length, 1);
  });

  check('timer dry-run/apply is bounded and cannot activate unqualified candidates', () => {
    const { root, store } = mkProject();
    roots.push(root);
    seed(root, store);
    const registry = mkRegistry(root, store);

    const dryRun = runJson<PlaybookPromotionTimerReport>(registry, 'playbook_promotion_timer', {
      storyId: STORY_ID,
      trial: true,
      activate: true,
      trialLimit: 2,
      apply: false,
      json: true,
    });
    assert.equal(dryRun.dryRun, true);
    assert.equal(dryRun.bounded, true);
    assert.equal(dryRun.limits.trial, 2);
    assert.equal(dryRun.steps.find((step) => step.step === 'trial')?.status, 'dry-run');
    assert.equal(dryRun.steps.find((step) => step.step === 'activate')?.status, 'dry-run');
    assert.equal(readPlaybookOutcomeEvents(root).length, 0, 'timer dry-run writes no outcomes');

    const applied = runJson<PlaybookPromotionTimerReport>(registry, 'playbook_promotion_timer', {
      storyId: STORY_ID,
      trial: true,
      activate: true,
      trialLimit: 2,
      apply: true,
      json: true,
    });
    const trialStep = applied.steps.find((step) => step.step === 'trial');
    const activateStep = applied.steps.find((step) => step.step === 'activate');
    assert.equal(trialStep?.status, 'applied');
    assert.equal(activateStep?.status, 'blocked');
    assert.match(activateStep?.message ?? '', /fail-closed|blocked=/);
    assert.equal(readPlaybookOutcomeEvents(root).length, 2);
    assert.equal(readPlaybookTrialControlEvents(root).length, 2);
    assert.equal(readPlaybookOutcomeEvents(root).every((event) => event.outcome.verdict === 'unknown'), true);
    assert.equal(readPlaybookAutoActivationEvents(root).length, 0);
    const statuses = new Map(readPlaybooks(root).map((row) => [row.id, row.status]));
    assert.equal(statuses.get('PBP-101'), 'candidate');
    assert.equal(statuses.get('PBP-102'), 'candidate');
    assert.equal(statuses.get('PBP-999'), 'active');
  });

  check('command catalog, registry, policies, and process fact levels wire automation commands', () => {
    const { root, store } = mkProject();
    roots.push(root);
    const registry = mkRegistry(root, store);
    const names = ['playbook_seed_backfill', 'playbook_trial_run', 'playbook_promotion_timer'] as const;
    for (const name of names) {
      assert.ok(MAIN_TOOLS.some((tool) => tool.name === name), `MAIN_TOOLS includes ${name}`);
      assert.equal(registry.has(name), true, `registry includes ${name}`);
      assert.equal(COMMAND_POLICIES[name].ownershipClass, 'mainSharedMutating', `${name} ownership policy`);
      assert.equal(COMMAND_POLICIES[name].destructiveRisk, 'metadata-write', `${name} destructive risk`);
      assert.equal((COMMAND_POLICIES as any)[name]?.gateEvidence, undefined, `${name} is not gate evidence`);
      assert.equal(PROCESS_FACT_LEVELS.find((entry) => entry.name === name)?.level, 'L2', `${name} fact level`);
      assert.equal(isCommandAllowed(name, 'DEV'), true, `${name} allowed in DEV by playbook_* phase pattern`);
      assert.equal(READ_ONLY_COMMANDS.has(name), false, `${name} is not read-only`);
    }
  });
} finally {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
}

if (process.exitCode) {
  console.error(`playbook trial automation smoke failed: ${passed}/${total} checks passed`);
  process.exit(process.exitCode);
}

console.log(`playbook trial automation smoke passed: ${passed}/${total} checks`);
