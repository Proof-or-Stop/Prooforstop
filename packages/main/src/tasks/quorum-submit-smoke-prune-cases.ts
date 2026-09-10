#!/usr/bin/env node



import assert from 'node:assert/strict';

import { execFileSync, spawnSync } from 'node:child_process';

import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';


import { dirname, join, relative } from 'node:path';

import { fileURLToPath } from 'node:url';

import ts from 'typescript';

import { captureLifecycleMetadataTransaction } from '../core/auto-commit-metadata.js';

import { canonicalDigest } from '../core/authority-signing.js';

import { DEFAULT_PHASE_TOOLS, isCommandAllowed, resetConfigCache } from '../core/config.js';

import {
  currentGitHead,
  currentMaterialHash,
  currentStoryFilesHash,
  EMPTY_STORY_FILES_HASH,
  isMaterialExcludedPath,
} from '../core/evidence-freshness.js';

import { signFinding, signReviewPass } from '../core/finding-verify.js';

import { collectReviewerEvidenceState, signReviewRun, verifyReviewRunPromptEnvelope } from '../core/review-run.js';

import {
  deriveCanonicalHostKeyId,
  deriveHostVerdictBindings,
  HOST_VERDICT_PROMPT_DIGEST_SCHEMA,
  HOST_VERDICT_PROMPT_PURPOSE,
  HOST_VERDICT_VALIDATION_DIGEST_SCHEMA,
} from '../core/host-verdict-bindings.js';

import { evaluateReviewAssuranceFloor } from '../core/review-assurance-floor.js';

import { evaluateHostVerdictRounds } from '../core/host-independence.js';

import { acquireMkdirLock } from '../core/mkdir-lock.js';

import { eventsWithStoryFilesHashDowngrade } from '../core/review-escalation.js';

import { canPassReviewGuard, type StoryMachineContext } from '../core/machine.js';

import { resetSessionIdForTest, resolveSessionIdentity } from '../core/owner-session.js';

import { storyRuntimeLockPath } from '../core/validation-execution-lock.js';

import { computePromptEnvelopeId } from '../core/prompt-envelope.js';

import { PROMPT_ENVELOPE_ROLLOUT_VERSION } from '../core/prompt-role-contract-registry.js';

import { readPromptRegistry, renderPromptEntryForHost, type PromptHost } from '../core/prompt-registry.js';

import { StoryStore } from '../core/store.js';

import { listVerdicts, summarizeVerdicts } from '../core/verdicts.js';

import { createMainRegistry } from '../registry.js';

import { createQuorumPruneHandlers } from '../handlers/quorum-prune.js';

import { createQuorumSubmitHandlers } from '../handlers/quorum-submit.js';

import type { HandlerContext } from '../handlers/context.js';

import { reviewerPromptHostForProvider } from '../handlers/story-dispatch.js';

import type { ChecklistData, Finding, ReviewPass, ReviewRun, StoryInfo } from '../core/types.js';

import { STATE_DIR_NAMES, PROOF_OR_STOP_ADAPTER_DIR, PROOF_OR_STOP_STATE_DIR } from '../core/brand-paths.js';

import { defineQuorumSmokeCase } from './quorum-submit-smoke-case-catalog.js';

import * as legacy from './quorum-submit-smoke-integration-cases.js';



const {
  STORY_ID,
  DIST_CLI_PATH,
  DIST_DIRTY_GATE_POLICY_PATH,
  IMPLEMENTATION_REPO_ROOT,
  HISTORICAL_RED_COMMIT,
  REVIEW_ROUND,
  COMMIT_ENV,
  REVIEW_LANES,
  MIRRORED_REPO_IGNORE_PATTERNS,
  reviewerReadManifest,
  git,
  write,
  writeConfig,
  story,
  checklist,
  makeFixture,
  runFixtureCli,
  withFreshFixture,
  quorumArgs,
  hostVerdictEventCount,
  seedLargeCommittedProcessEvents,
  verdictFileCount,
  assertQuorumRefuses,
  startRunAndPass,
  SESSION_ENV_KEYS,
  withClearedSessionEnvironment,
  withSessionProvider,
  recordReviewerPasses,
  commitMaterialChange,
  commitMainDrift,
  quorumProcessEventsPath,
  storyBackupFiles,
  storyOwnedDiffBlobs,
  wholeTreeDiffPaths,
  injectPoisonedDuplicates,
  commitEventsRewrite,
  committedHostVerdictLines,
  injectPrecedingFailVerdict,
  appendDuplicatesForRunId,
  quorumFloorRounds,
  productionTypeScriptFiles,
  directProcessEventAppends,
} = legacy;

export const QUORUM_SMOKE_CASES = [
  defineQuorumSmokeCase({
    id: "qsm-051",
    title: "quorum_prune dry-run lists the poisoned duplicates without mutating",
    domain: "prune",
    shard: "prune",
    capabilities: [],
    callbackBound: true,
    registrationSource: "packages/main/src/tasks/quorum-submit-smoke-prune-cases.ts",
    run: () => {
    withFreshFixture((fixture) => {
      injectPoisonedDuplicates(fixture);
      const eventsPath = quorumProcessEventsPath(fixture);
      const beforeBytes = readFileSync(eventsPath);
      const beforeHead = git(fixture.root, ['rev-parse', 'HEAD']);
      const collapsed = quorumFloorRounds(fixture);
      assert.equal(collapsed.validRounds.length, 0, 'poisoned floor has zero valid rounds');
      assert.ok(
        collapsed.invalidRounds.some(round => round.reasons.some(reason => /duplicate host\/session\/key identity/.test(reason))),
        'poisoning collapses rounds as duplicate host/session/key identity',
      );
      const result: any = fixture.registry.get('quorum_prune')!({ storyId: STORY_ID, json: true });
      assert.equal(result.applied, false, 'dry-run does not apply');
      assert.equal(result.dryRun, true);
      assert.equal(result.backupPath, null, 'dry-run writes no backup');
      assert.equal(result.metadataCommitSha, null, 'dry-run makes no commit');
      assert.equal(result.duplicateGroups.length, 6, 'one duplicate group per runId per host');
      assert.equal(result.removedVerdictCount, 6, 'six losing verdict events would be removed');
      for (const group of result.duplicateGroups) {
        assert.equal(group.members.length, 2);
        assert.equal(group.members.filter((member: any) => member.disposition === 'KEEP').length, 1, 'exactly one kept per group');
        assert.equal(group.members.filter((member: any) => member.disposition === 'REMOVE').length, 1, 'exactly one removed per group');
        for (const member of group.members) {
          assert.ok(member.verdictId, 'dry-run reports verdictId');
          assert.ok(member.runId, 'dry-run reports runId');
          assert.ok(member.hostId, 'dry-run reports hostId');
          assert.ok(member.materialDigest, 'dry-run reports materialDigest');
          assert.ok(member.timestamp, 'dry-run reports timestamp');
        }
      }
      assert.deepEqual(readFileSync(eventsPath), beforeBytes, 'dry-run mutates nothing');
      assert.equal(git(fixture.root, ['rev-parse', 'HEAD']), beforeHead, 'dry-run advances no HEAD');
      assert.equal(storyBackupFiles(fixture).length, 0, 'dry-run leaves no backup file');
    });
  },
  }),
  defineQuorumSmokeCase({
    id: "qsm-052",
    title: "quorum_prune apply removes the losing set, backs up, and the floor returns to full-3x2",
    domain: "prune",
    shard: "prune",
    capabilities: [],
    callbackBound: true,
    registrationSource: "packages/main/src/tasks/quorum-submit-smoke-prune-cases.ts",
    run: () => {
    withFreshFixture((fixture) => {
      const { originalHostVerdictLines } = injectPoisonedDuplicates(fixture);
      const eventsPath = quorumProcessEventsPath(fixture);
      const poisonedBytes = readFileSync(eventsPath);
      const beforeLines = readFileSync(eventsPath, 'utf8').split('\n');
      assert.equal(quorumFloorRounds(fixture).validRounds.length, 0, 'floor collapsed before prune');
      assert.equal(verdictFileCount(fixture.root), 6, 'six verdict cache files exist before prune');
      const result: any = fixture.registry.get('quorum_prune')!({ storyId: STORY_ID, apply: true, json: true });
      assert.equal(result.applied, true);
      assert.equal(result.removedVerdictCount, 6);
      assert.ok(result.metadataCommitSha, 'apply commits the pruned log');
      assert.ok(result.backupPath && existsSync(result.backupPath), 'timestamped backup created');
      assert.match(
        result.backupPath,
        /process-events\.jsonl\.\d{4}-\d{2}-\d{2}T[0-9-]+Z(?:-\d+)?\.bak$/,
        'backup name is timestamped AND keeps the ignored .bak extension last',
      );
      assert.deepEqual(readFileSync(result.backupPath), poisonedBytes, 'backup is a byte-identical copy of the pre-prune log');
      const losing = new Set(originalHostVerdictLines);
      const expectedAfter = beforeLines.filter(line => !losing.has(line));
      assert.deepEqual(
        readFileSync(eventsPath, 'utf8').split('\n'),
        expectedAfter,
        'only the losing host_verdict lines removed; every other line byte-identical and in order',
      );
      const recovered = quorumFloorRounds(fixture);
      assert.equal(recovered.validRounds.length, 3, 'floor returns to three valid rounds');
      assert.equal(recovered.invalidRounds.length, 0);
      for (const round of recovered.validRounds) {
        assert.equal(round.passingHostIds.length, 2, 'each recovered round has two passing independent hosts');
      }
      assert.equal(result.removedVerdictFiles.length, 6, 'losing verdict cache files were pruned best-effort');
      assert.equal(git(fixture.root, ['status', '--porcelain=v1', '--', quorumProcessEventsPath(fixture)]), '', 'pruned log is committed clean');
    });
  },
  }),
  defineQuorumSmokeCase({
    id: "qsm-053",
    title: "quorum_prune resolves AND executes through the built CLI in the story phase (catalog + policy + DEFAULT_PHASE_TOOLS)",
    domain: "prune",
    shard: "prune",
    capabilities: [],
    callbackBound: true,
    registrationSource: "packages/main/src/tasks/quorum-submit-smoke-prune-cases.ts",
    run: () => {
    // CHK-003:happy:2 (F-004): every in-scope wiring point, including the config.ts
    // DEFAULT_PHASE_TOOLS entry, is verified BEHAVIORALLY by this bound command.
    assert.ok(
      DEFAULT_PHASE_TOOLS['*'].includes('quorum_prune'),
      'config.ts DEFAULT_PHASE_TOOLS["*"] lists quorum_prune',
    );
    assert.equal(isCommandAllowed('quorum_prune', 'REVIEW'), true, 'the phase-tool resolver admits quorum_prune in the fixture story phase');
    withFreshFixture((fixture) => {
      injectPoisonedDuplicates(fixture);
      // Negative control FIRST: the fixture declares no phaseTools, so the CLI phase gate runs
      // against DEFAULT_PHASE_TOOLS and genuinely blocks a command that is not listed for
      // REVIEW. Without this, the exit-0 below would be vacuous.
      const blocked = runFixtureCli(fixture.root, ['plan_set', `--storyId=${STORY_ID}`]);
      assert.notEqual(blocked.status, 0, 'phase-gate control command is refused');
      assert.match(
        `${blocked.stdout}\n${blocked.stderr}`,
        /is not available in REVIEW phase/,
        'the DEFAULT_PHASE_TOOLS-driven phase gate is live in this fixture',
      );
      const dryRun = runFixtureCli(fixture.root, ['quorum_prune', JSON.stringify({ storyId: STORY_ID, json: true })]);
      const combined = `${dryRun.stdout}\n${dryRun.stderr}`;
      assert.doesNotMatch(combined, /unknown command|Unknown command|not a registered command|Unknown subcommand/i, 'quorum_prune resolves as a registered command, not unknown');
      assert.doesNotMatch(combined, /is not available in REVIEW phase/, 'quorum_prune is NOT phase-refused: the DEFAULT_PHASE_TOOLS entry is live');
      assert.equal(dryRun.status, 0, `quorum_prune executes through the built CLI: ${combined}`);
      const payload = JSON.parse(dryRun.stdout.trim()) as { schemaVersion: string; duplicateGroups: unknown[]; dryRun: boolean };
      assert.equal(payload.schemaVersion, 'proof-or-stop.quorum_prune.v1', 'the real handler ran end-to-end through catalog + policy + phase gate');
      assert.equal(payload.dryRun, true);
      assert.equal(payload.duplicateGroups.length, 6, 'the dispatched handler actually projected the poisoned groups');
    });
  },
  }),
  defineQuorumSmokeCase({
    id: "qsm-054",
    title: "quorum_prune refuses when there is nothing to prune",
    domain: "prune",
    shard: "prune",
    capabilities: [],
    callbackBound: true,
    registrationSource: "packages/main/src/tasks/quorum-submit-smoke-prune-cases.ts",
    run: () => {
    withFreshFixture((fixture) => {
      recordReviewerPasses(fixture.registry);
      fixture.registry.get('quorum_submit')!(quorumArgs());
      const beforeHead = git(fixture.root, ['rev-parse', 'HEAD']);
      assert.throws(
        () => fixture.registry.get('quorum_prune')!({ storyId: STORY_ID, apply: true, json: true }),
        /nothing to prune/,
        'a clean quorum has nothing to prune',
      );
      assert.equal(git(fixture.root, ['rev-parse', 'HEAD']), beforeHead, 'refusal makes no commit');
      assert.equal(storyBackupFiles(fixture).length, 0, 'refusal writes no backup');
    });
  },
  }),
  defineQuorumSmokeCase({
    id: "qsm-055",
    title: "quorum_prune apply refuses on a dirty tree before any mutation",
    domain: "prune",
    shard: "prune",
    capabilities: [],
    callbackBound: true,
    registrationSource: "packages/main/src/tasks/quorum-submit-smoke-prune-cases.ts",
    run: () => {
    withFreshFixture((fixture) => {
      injectPoisonedDuplicates(fixture);
      const eventsPath = quorumProcessEventsPath(fixture);
      const poisonedBytes = readFileSync(eventsPath);
      const beforeHead = git(fixture.root, ['rev-parse', 'HEAD']);
      write(fixture.root, 'packages/main/src/index.ts', 'export const seed = true;\nexport const dirty = true;\n');
      assert.throws(
        () => fixture.registry.get('quorum_prune')!({ storyId: STORY_ID, apply: true, json: true }),
        /worktree\/index must be clean/,
        'a dirty tree refuses before any file I/O',
      );
      assert.equal(git(fixture.root, ['rev-parse', 'HEAD']), beforeHead);
      assert.deepEqual(readFileSync(eventsPath), poisonedBytes, 'refusal leaves the poisoned log untouched');
      assert.equal(storyBackupFiles(fixture).length, 0, 'refusal writes no backup');
    });
  },
  }),
  defineQuorumSmokeCase({
    id: "qsm-056",
    title: "quorum_prune keeps exactly one event per group for a triple-duplicate",
    domain: "prune",
    shard: "prune",
    capabilities: [],
    callbackBound: true,
    registrationSource: "packages/main/src/tasks/quorum-submit-smoke-prune-cases.ts",
    run: () => {
    withFreshFixture((fixture) => {
      injectPoisonedDuplicates(fixture, { copies: 2 });
      const dry: any = fixture.registry.get('quorum_prune')!({ storyId: STORY_ID, json: true });
      assert.equal(dry.duplicateGroups.length, 6);
      for (const group of dry.duplicateGroups) {
        assert.equal(group.members.length, 3, 'triple duplicate has three members');
        assert.equal(group.members.filter((member: any) => member.disposition === 'KEEP').length, 1, 'exactly one kept');
        assert.equal(group.members.filter((member: any) => member.disposition === 'REMOVE').length, 2, 'other two removed');
      }
      assert.equal(dry.removedVerdictCount, 12, 'six groups remove two each');
      const applied: any = fixture.registry.get('quorum_prune')!({ storyId: STORY_ID, apply: true, json: true });
      assert.equal(applied.removedVerdictCount, 12);
      const recovered = quorumFloorRounds(fixture);
      assert.equal(recovered.validRounds.length, 3);
      for (const round of recovered.validRounds) assert.equal(round.passingHostIds.length, 2);
    });
  },
  }),
  defineQuorumSmokeCase({
    id: "qsm-057",
    title: "quorum_prune runIds filter prunes only the specified runIds",
    domain: "prune",
    shard: "prune",
    capabilities: [],
    callbackBound: true,
    registrationSource: "packages/main/src/tasks/quorum-submit-smoke-prune-cases.ts",
    run: () => {
    withFreshFixture((fixture) => {
      injectPoisonedDuplicates(fixture);
      const targetRunId = `${STORY_ID}-q-r1`;
      const dry: any = fixture.registry.get('quorum_prune')!({ storyId: STORY_ID, runIds: [targetRunId], json: true });
      assert.equal(dry.duplicateGroups.length, 2, 'only r1 has duplicate groups (two hosts)');
      for (const group of dry.duplicateGroups) assert.equal(group.runId, targetRunId);
      assert.equal(dry.removedVerdictCount, 2, 'only r1 duplicates are counted');
      assert.deepEqual(dry.runIdsFilter, [targetRunId]);
      const applied: any = fixture.registry.get('quorum_prune')!({ storyId: STORY_ID, runIds: [targetRunId], apply: true, json: true });
      assert.equal(applied.removedVerdictCount, 2);
      const rounds = quorumFloorRounds(fixture);
      assert.ok(rounds.validRounds.map(round => round.runId).includes(targetRunId), 'r1 recovered after targeted prune');
      assert.ok(rounds.invalidRounds.some(round => round.runId === `${STORY_ID}-q-r2`), 'r2 duplicates left untouched');
      assert.ok(rounds.invalidRounds.some(round => round.runId === `${STORY_ID}-q-r3`), 'r3 duplicates left untouched');
    });
  },
  }),
  defineQuorumSmokeCase({
    id: "qsm-058",
    title: "quorum_prune preserves interleaved non-host_verdict lines byte-identically",
    domain: "prune",
    shard: "prune",
    capabilities: [],
    callbackBound: true,
    registrationSource: "packages/main/src/tasks/quorum-submit-smoke-prune-cases.ts",
    run: () => {
    withFreshFixture((fixture) => {
      const interleave = JSON.stringify({ type: 'review_run', marker: 'B-3144-preserve-interleaved', reviewRunId: 'B-3144-interleave' });
      const { originalHostVerdictLines } = injectPoisonedDuplicates(fixture, { interleaveLine: interleave });
      const eventsPath = quorumProcessEventsPath(fixture);
      const beforeLines = readFileSync(eventsPath, 'utf8').split('\n');
      assert.ok(beforeLines.includes(interleave), 'interleaved non-host_verdict line was committed');
      fixture.registry.get('quorum_prune')!({ storyId: STORY_ID, apply: true, json: true });
      const afterLines = readFileSync(eventsPath, 'utf8').split('\n');
      assert.ok(afterLines.includes(interleave), 'interleaved non-host_verdict line preserved verbatim');
      const losing = new Set(originalHostVerdictLines);
      const expectedAfter = beforeLines.filter(line => !losing.has(line));
      assert.deepEqual(afterLines, expectedAfter, 'non-host_verdict lines preserved in original order; only losing host_verdict rows removed');
    });
  },
  }),
  defineQuorumSmokeCase({
    id: "qsm-059",
    title: "quorum_prune keep:oldest-material inverts which duplicate survives",
    domain: "prune",
    shard: "prune",
    capabilities: [],
    callbackBound: true,
    registrationSource: "packages/main/src/tasks/quorum-submit-smoke-prune-cases.ts",
    run: () => {
    withFreshFixture((fixture) => {
      const { first } = injectPoisonedDuplicates(fixture);
      const applied: any = fixture.registry.get('quorum_prune')!({ storyId: STORY_ID, apply: true, keep: 'oldest-material', json: true });
      assert.equal(applied.keep, 'oldest-material');
      assert.equal(applied.removedVerdictCount, 6);
      const survivors = fixture.store.readProcessEvents(STORY_ID).filter(event => event.type === 'host_verdict');
      assert.equal(survivors.length, 6, 'one surviving verdict per host per round');
      for (const survivor of survivors) {
        assert.equal(survivor.materialDigest, first.materialDigest, 'oldest-material keeps the earlier (older-material) verdict, not the drift copy');
      }
      const recovered = quorumFloorRounds(fixture);
      assert.equal(recovered.validRounds.length, 3);
      for (const round of recovered.validRounds) assert.equal(round.passingHostIds.length, 2);
    });
  },
  }),
  defineQuorumSmokeCase({
    id: "qsm-060",
    title: "quorum_prune refuses an uncommitted process-events file",
    domain: "prune",
    shard: "prune",
    capabilities: [],
    callbackBound: true,
    registrationSource: "packages/main/src/tasks/quorum-submit-smoke-prune-cases.ts",
    run: () => {
    withFreshFixture((fixture) => {
      recordReviewerPasses(fixture.registry);
      fixture.registry.get('quorum_submit')!(quorumArgs());
      const eventsPath = quorumProcessEventsPath(fixture);
      const raw = readFileSync(eventsPath, 'utf8');
      const dupLines = raw.split('\n').filter(Boolean).flatMap((line) => {
        let event: Record<string, unknown>;
        try { event = JSON.parse(line) as Record<string, unknown>; } catch { return []; }
        return event.type === 'host_verdict'
          ? [JSON.stringify({ ...event, verdictId: `${String(event.verdictId)}-dup`, materialDigest: 'B-3144-uncommitted-drift' })]
          : [];
      });
      writeFileSync(eventsPath, `${raw}${dupLines.join('\n')}\n`, 'utf8');
      const beforeBytes = readFileSync(eventsPath);
      const beforeHead = git(fixture.root, ['rev-parse', 'HEAD']);
      assert.throws(
        () => fixture.registry.get('quorum_prune')!({ storyId: STORY_ID, apply: true, json: true }),
        /uncommitted changes|prune only operates on the committed/,
        'an uncommitted events file refuses before any mutation',
      );
      assert.equal(git(fixture.root, ['rev-parse', 'HEAD']), beforeHead);
      assert.deepEqual(readFileSync(eventsPath), beforeBytes, 'refusal leaves the uncommitted file untouched');
      assert.equal(storyBackupFiles(fixture).length, 0, 'refusal writes no backup');
    });
  },
  }),
  defineQuorumSmokeCase({
    id: "qsm-061",
    title: "quorum_prune never overwrites a previous run backup",
    domain: "prune",
    shard: "prune",
    capabilities: [],
    callbackBound: true,
    registrationSource: "packages/main/src/tasks/quorum-submit-smoke-prune-cases.ts",
    run: () => {
    withFreshFixture((fixture) => {
      injectPoisonedDuplicates(fixture);
      const firstPrune: any = fixture.registry.get('quorum_prune')!({ storyId: STORY_ID, apply: true, json: true });
      assert.ok(firstPrune.backupPath && existsSync(firstPrune.backupPath));
      const firstBackupBytes = readFileSync(firstPrune.backupPath);
      const eventsPath = quorumProcessEventsPath(fixture);
      const raw = readFileSync(eventsPath, 'utf8');
      const dupLines = raw.split('\n').filter(Boolean).flatMap((line) => {
        let event: Record<string, unknown>;
        try { event = JSON.parse(line) as Record<string, unknown>; } catch { return []; }
        return event.type === 'host_verdict'
          ? [JSON.stringify({ ...event, verdictId: `${String(event.verdictId)}-dup2`, materialDigest: 'B-3144-second-drift' })]
          : [];
      });
      writeFileSync(eventsPath, `${raw}${dupLines.join('\n')}\n`, 'utf8');
      git(fixture.root, ['add', '-A']);
      git(fixture.root, [...COMMIT_ENV, 'commit', '-m', 're-poison after first prune']);
      const secondPrune: any = fixture.registry.get('quorum_prune')!({ storyId: STORY_ID, apply: true, json: true });
      assert.ok(secondPrune.backupPath && existsSync(secondPrune.backupPath));
      assert.notEqual(secondPrune.backupPath, firstPrune.backupPath, 'second prune uses a distinct backup path');
      assert.deepEqual(readFileSync(firstPrune.backupPath), firstBackupBytes, 'the earlier backup is not overwritten');
    });
  },
  }),
  defineQuorumSmokeCase({
    id: "qsm-062",
    title: "quorum_prune apply leaves a clean worktree and a second apply needs no manual git",
    domain: "prune",
    shard: "prune",
    capabilities: [],
    callbackBound: true,
    registrationSource: "packages/main/src/tasks/quorum-submit-smoke-prune-cases.ts",
    run: () => {
    // F-002/F-007 RED: the pre-prune backup is written into the GIT-TRACKED story dir while the
    // prune transaction stages only process-events.jsonl. Unless the backup name genuinely
    // matches the repository's `*.bak` ignore pattern it survives as untracked dirt, and both
    // assertCleanPruneBaseline and quorum_submit's assertCleanQuorumBaseline (unscoped
    // `git status --porcelain=v1 --untracked-files=all`) then refuse on the tool's OWN artifact.
    // The fixture mirrors the repo's ignore rules, so first prove the real pattern still exists —
    // otherwise the mirror could silently become a self-serving fixture.
    const repoIgnoreLines = readFileSync(join(IMPLEMENTATION_REPO_ROOT, '.gitignore'), 'utf8')
      .split('\n')
      .map(line => line.trim());
    for (const pattern of MIRRORED_REPO_IGNORE_PATTERNS) {
      assert.ok(
        repoIgnoreLines.includes(pattern),
        `the implementation repo .gitignore still carries the mirrored pattern ${pattern}`,
      );
    }
    assert.ok(
      repoIgnoreLines.includes('*.bak'),
      'the *.bak pattern the backup name relies on is a real, shipped repo rule',
    );
    withFreshFixture((fixture) => {
      injectPoisonedDuplicates(fixture);
      const r1 = `${STORY_ID}-q-r1`;
      const r2 = `${STORY_ID}-q-r2`;
      const first: any = fixture.registry.get('quorum_prune')!({ storyId: STORY_ID, runIds: [r1], apply: true, json: true });
      assert.equal(first.applied, true, 'first apply succeeds');
      assert.ok(first.backupPath.endsWith('.bak'), `backup must end in .bak so *.bak covers it (got ${first.backupPath})`);
      assert.ok(existsSync(first.backupPath), 'the backup really is written into the tracked story dir');
      assert.equal(
        git(fixture.root, ['status', '--porcelain=v1', '--untracked-files=all']),
        '',
        'a successful apply leaves NO worktree dirt — the exact predicate both clean-baseline checks use',
      );
      const firstBackupBytes = readFileSync(first.backupPath);
      // The next legitimate recovery action, with NO intervening git add/commit whatsoever.
      const second: any = fixture.registry.get('quorum_prune')!({ storyId: STORY_ID, runIds: [r2], apply: true, json: true });
      assert.equal(second.applied, true, 'the immediate second apply is not blocked by the first apply backup');
      assert.notEqual(second.backupPath, first.backupPath, 'the second apply writes a distinct backup');
      assert.deepEqual(readFileSync(first.backupPath), firstBackupBytes, 'the first backup survives the second apply untouched');
      assert.equal(
        git(fixture.root, ['status', '--porcelain=v1', '--untracked-files=all']),
        '',
        'the tree is still clean after the second apply',
      );
      assert.equal(storyBackupFiles(fixture).length, 2, 'both backups are retained side by side');
      const rounds = quorumFloorRounds(fixture);
      assert.ok(rounds.validRounds.map(round => round.runId).includes(r1), 'r1 recovered by the first apply');
      assert.ok(rounds.validRounds.map(round => round.runId).includes(r2), 'r2 recovered by the second apply with no manual git');
    });
  },
  }),
  defineQuorumSmokeCase({
    id: "qsm-063",
    title: "quorum_prune apply through the production CLI under codex leaves no process-event dirt",
    domain: "prune",
    shard: "prune",
    capabilities: [],
    callbackBound: true,
    registrationSource: "packages/main/src/tasks/quorum-submit-smoke-prune-cases.ts",
    sentinel: "real",
    run: () => {
    // F-001 RED: cli-engine's generic post-handler codex_cli process-event append must exclude
    // quorum_prune exactly as it excludes quorum_submit, otherwise it re-dirties the very
    // process-events.jsonl the handler just atomically committed. runFixtureCli sets
    // PROOF_OR_STOP_ACTIVITY_SOURCE=codex, which is the only condition under which the append fires.
    withFreshFixture((fixture) => {
      injectPoisonedDuplicates(fixture);
      const beforeHead = git(fixture.root, ['rev-parse', 'HEAD']);
      const applied = runFixtureCli(fixture.root, ['quorum_prune', JSON.stringify({ storyId: STORY_ID, apply: true, json: true })]);
      const combined = `${applied.stdout}\n${applied.stderr}`;
      assert.equal(applied.status, 0, combined);
      const payload = JSON.parse(applied.stdout.trim()) as { applied: boolean; removedVerdictCount: number; metadataCommitSha: string };
      assert.equal(payload.applied, true);
      assert.equal(payload.removedVerdictCount, 6);
      assert.ok(payload.metadataCommitSha, 'the prune committed through the lifecycle-metadata transaction');
      assert.notEqual(git(fixture.root, ['rev-parse', 'HEAD']), beforeHead, 'apply advances HEAD with the pruned log');
      assert.equal(
        git(fixture.root, ['status', '--porcelain=v1', '--untracked-files=all']),
        '',
        'no codex_cli append re-dirties the file quorum_prune just committed, and no backup is left untracked',
      );
      // The next real call must therefore still be able to run: it reaches its own semantic
      // refusal (nothing left to prune) instead of a pre-dirty refusal about our own artifact.
      const next = runFixtureCli(fixture.root, ['quorum_prune', JSON.stringify({ storyId: STORY_ID, apply: true, json: true })]);
      const nextCombined = `${next.stdout}\n${next.stderr}`;
      assert.match(nextCombined, /nothing to prune/, `follow-up call reaches the semantic refusal: ${nextCombined}`);
      assert.doesNotMatch(nextCombined, /worktree\/index must be clean|has uncommitted changes/, 'follow-up call is not blocked by the tool\'s own leftovers');
    });
  },
  }),
  defineQuorumSmokeCase({
    id: "qsm-064",
    title: "quorum_prune --dryRun is a real declared flag, is honored, and refuses when combined with --apply",
    domain: "prune",
    shard: "prune",
    capabilities: [],
    callbackBound: true,
    registrationSource: "packages/main/src/tasks/quorum-submit-smoke-prune-cases.ts",
    run: () => {
    // F-008/F-009 RED: without a `dryRun` schema field, `--dryRun` is silently swallowed by the
    // non-strict flag parser and help-renderer falls through to "Dry-run: always-on", which
    // inverts the safety boundary for a command whose apply path really does mutate git state.
    withFreshFixture((fixture) => {
      injectPoisonedDuplicates(fixture);
      const beforeHead = git(fixture.root, ['rev-parse', 'HEAD']);
      const dry = runFixtureCli(fixture.root, ['quorum_prune', `--storyId=${STORY_ID}`, '--dryRun', '--json']);
      assert.equal(dry.status, 0, `${dry.stdout}\n${dry.stderr}`);
      const dryPayload = JSON.parse(dry.stdout.trim()) as { dryRun: boolean; applied: boolean; duplicateGroups: unknown[] };
      assert.equal(dryPayload.dryRun, true, '--dryRun projects');
      assert.equal(dryPayload.applied, false);
      assert.equal(dryPayload.duplicateGroups.length, 6);
      assert.equal(git(fixture.root, ['rev-parse', 'HEAD']), beforeHead, '--dryRun makes no commit');
      assert.equal(storyBackupFiles(fixture).length, 0, '--dryRun writes no backup');

      // An explicitly conflicting combination must REFUSE, never silently pick a side.
      const conflict = runFixtureCli(fixture.root, ['quorum_prune', `--storyId=${STORY_ID}`, '--dryRun', '--apply']);
      const conflictOut = `${conflict.stdout}\n${conflict.stderr}`;
      assert.notEqual(conflict.status, 0, `--dryRun --apply must fail: ${conflictOut}`);
      assert.match(conflictOut, /pass either apply:true or dryRun:true, not both/i, conflictOut);
      assert.equal(git(fixture.root, ['rev-parse', 'HEAD']), beforeHead, 'the conflict refusal makes no commit');
      assert.equal(storyBackupFiles(fixture).length, 0, 'the conflict refusal writes no backup');

      // The auto-generated help must state the truth about when this command mutates.
      const help = runFixtureCli(fixture.root, ['quorum_prune', '--help']);
      const helpText = `${help.stdout}\n${help.stderr}`;
      assert.match(helpText, /--dryRun\s+boolean/, 'help documents --dryRun as a declared boolean flag');
      assert.doesNotMatch(helpText, /Dry-run: always-on/i, 'help must not claim the command never executes a side effect');
      assert.match(helpText, /Dry-run: default-on via --dryRun=true/, 'help states the real default-on-with-explicit-apply contract');

      // And apply:true still mutates for real, so the help claim above is not the safe lie.
      const realApply = runFixtureCli(fixture.root, ['quorum_prune', JSON.stringify({ storyId: STORY_ID, apply: true, json: true })]);
      assert.equal(realApply.status, 0, `${realApply.stdout}\n${realApply.stderr}`);
      assert.notEqual(git(fixture.root, ['rev-parse', 'HEAD']), beforeHead, 'apply:true really does commit');
      assert.equal(storyBackupFiles(fixture).length, 1, 'apply:true really does write a backup');
    });
  },
  }),
  defineQuorumSmokeCase({
    id: "qsm-065",
    title: "quorum_prune dryRun:false executes instead of being a silent no-op",
    domain: "prune",
    shard: "prune",
    capabilities: [],
    callbackBound: true,
    registrationSource: "packages/main/src/tasks/quorum-submit-smoke-prune-cases.ts",
    run: () => {
    // F-010 RED: an explicit dryRun:false used to fall through to the projection path, so an
    // operator who said "do not dry-run" got a dry run anyway and CHK-003's userSees promise
    // ("without --dryRun it backs up, removes them, commits") was false. Omitting dryRun must
    // still default to the safe projection — the default carries the safety, not the silent
    // discarding of an explicit instruction.
    withFreshFixture((fixture) => {
      injectPoisonedDuplicates(fixture);
      const beforeHead = git(fixture.root, ['rev-parse', 'HEAD']);

      // Omitted dryRun keeps the safe projection default.
      const omitted = runFixtureCli(fixture.root, ['quorum_prune', `--storyId=${STORY_ID}`, '--json']);
      assert.equal(omitted.status, 0, `${omitted.stdout}\n${omitted.stderr}`);
      const omittedPayload = JSON.parse(omitted.stdout.trim()) as { dryRun: boolean; applied: boolean };
      assert.equal(omittedPayload.applied, false, 'omitting dryRun still projects only');
      assert.equal(git(fixture.root, ['rev-parse', 'HEAD']), beforeHead, 'omitting dryRun makes no commit');
      assert.equal(storyBackupFiles(fixture).length, 0, 'omitting dryRun writes no backup');

      // An explicit dryRun:false executes exactly like apply:true.
      const explicitFalse = runFixtureCli(fixture.root, ['quorum_prune', JSON.stringify({ storyId: STORY_ID, dryRun: false, json: true })]);
      assert.equal(explicitFalse.status, 0, `${explicitFalse.stdout}\n${explicitFalse.stderr}`);
      const falsePayload = JSON.parse(explicitFalse.stdout.trim()) as { dryRun: boolean; applied: boolean; removedVerdictCount: number; removedVerdictIds: string[] };
      assert.equal(falsePayload.applied, true, 'dryRun:false executes');
      assert.equal(falsePayload.dryRun, false);
      assert.equal(falsePayload.removedVerdictCount, 6, 'dryRun:false removes the losing duplicate set');
      assert.equal(falsePayload.removedVerdictIds.length, 6);
      assert.notEqual(git(fixture.root, ['rev-parse', 'HEAD']), beforeHead, 'dryRun:false really does commit');
      assert.equal(storyBackupFiles(fixture).length, 1, 'dryRun:false really does write a backup');
      assert.equal(git(fixture.root, ['status', '--porcelain=v1', '--untracked-files=all']), '', 'dryRun:false leaves a clean tree');
    });
  },
  }),
  defineQuorumSmokeCase({
    id: "qsm-066",
    title: "quorum_prune refuses the symmetric apply:false + dryRun:false conflict",
    domain: "prune",
    shard: "prune",
    capabilities: [],
    callbackBound: true,
    registrationSource: "packages/main/src/tasks/quorum-submit-smoke-prune-cases.ts",
    run: () => {
    // F-012 RED: the F-010 fix resolved `apply === true || dryRun === false`, so {apply:false,
    // dryRun:false} silently EXECUTED a backup+rewrite+commit against an explicit apply:false —
    // resolving a contradiction toward the more dangerous side, which is exactly what the
    // conflict rule exists to prevent. Both contradictory pairs must refuse.
    withFreshFixture((fixture) => {
      injectPoisonedDuplicates(fixture);
      const beforeHead = git(fixture.root, ['rev-parse', 'HEAD']);
      const conflict = runFixtureCli(fixture.root, ['quorum_prune', JSON.stringify({ storyId: STORY_ID, apply: false, dryRun: false })]);
      const conflictOut = `${conflict.stdout}\n${conflict.stderr}`;
      assert.notEqual(conflict.status, 0, `apply:false + dryRun:false must fail: ${conflictOut}`);
      assert.match(conflictOut, /apply:false and dryRun:false contradict each other/i, conflictOut);
      assert.equal(git(fixture.root, ['rev-parse', 'HEAD']), beforeHead, 'the symmetric conflict makes no commit');
      assert.equal(storyBackupFiles(fixture).length, 0, 'the symmetric conflict writes no backup');

      // apply:false alone still projects rather than executing.
      const applyFalse = runFixtureCli(fixture.root, ['quorum_prune', JSON.stringify({ storyId: STORY_ID, apply: false, json: true })]);
      assert.equal(applyFalse.status, 0, `${applyFalse.stdout}\n${applyFalse.stderr}`);
      assert.equal((JSON.parse(applyFalse.stdout.trim()) as { applied: boolean }).applied, false, 'apply:false projects only');
      assert.equal(git(fixture.root, ['rev-parse', 'HEAD']), beforeHead, 'apply:false makes no commit');
    });
  },
  }),
  defineQuorumSmokeCase({
    id: "qsm-067",
    title: "every quorum_prune apply/dryRun description states both executors",
    domain: "prune",
    shard: "prune",
    capabilities: [],
    callbackBound: true,
    registrationSource: "packages/main/src/tasks/quorum-submit-smoke-prune-cases.ts",
    run: () => {
    // F-011 RED: the F-010 fix updated only the dryRun field description and one comment, leaving
    // five other prose sites claiming apply:true was the sole mutation trigger — including the
    // catalog's top-level description, which is the FIRST line of --help and contradicted the
    // corrected flag description a few lines below it in the same output.
    //
    // F-013 RED: the first version of THIS guard had the same blind spot one level down. It read
    // only the three block-level descriptions and never the per-flag `describe()` strings, which
    // are exactly what help-renderer prints per argument — so --help could (and did) show a
    // correct top-level description above a stale --dryRun line and a never-updated --apply line.
    // A guard with a coverage hole is worse than no guard: it reads as "this is protected". Every
    // site that renders or audits this contract is asserted here, including the two schema fields
    // and the handler JSDoc, plus a live --help render so the assertion is not source-only.
    const catalogSource = readFileSync(join(IMPLEMENTATION_REPO_ROOT, 'packages/main/src/cli/command-catalog.ts'), 'utf8');
    const factSource = readFileSync(join(IMPLEMENTATION_REPO_ROOT, 'packages/main/src/core/process-fact-levels.ts'), 'utf8');
    const policySource = readFileSync(join(IMPLEMENTATION_REPO_ROOT, 'packages/main/src/core/command-policy.ts'), 'utf8');
    const handlerSource = readFileSync(join(IMPLEMENTATION_REPO_ROOT, 'packages/main/src/handlers/quorum-prune.ts'), 'utf8');
    const catalogEntry = catalogSource.slice(catalogSource.indexOf("{ name: 'quorum_prune'"));
    const catalogBlock = catalogEntry.slice(0, catalogEntry.indexOf('}},'));
    const catalogDescription = catalogEntry.slice(0, catalogEntry.indexOf('schema:'));
    const fieldDescribe = (field: string): string => {
      const start = catalogBlock.indexOf(`${field}: z.`);
      return start < 0 ? '' : catalogBlock.slice(start, catalogBlock.indexOf('\n', start));
    };
    const argsTypeStart = handlerSource.indexOf('QuorumPruneArgs = {');
    const argsTypeEnd = handlerSource.indexOf('keep?: KeepSelector', argsTypeStart);
    assert.ok(argsTypeStart >= 0 && argsTypeEnd > argsTypeStart, 'QuorumPruneArgs declaration shape changed; update this guard');
    const argsInterface = handlerSource.slice(argsTypeStart, argsTypeEnd);
    for (const [label, prose] of [
      ['catalog top-level description', catalogDescription],
      ['catalog dryRun describe()', fieldDescribe('dryRun')],
      ['catalog apply describe()', fieldDescribe('apply')],
      ['process-fact rationale', factSource.split('\n').find(line => line.includes("name: 'quorum_prune'")) ?? ''],
      ['command-policy reason', policySource.split('\n').find(line => line.includes('quorum_prune: {')) ?? ''],
      ['QuorumPruneArgs JSDoc', argsInterface],
    ] as const) {
      assert.ok(prose.length > 0, `${label} was not found`);
      assert.match(prose, /dryRun:false/, `${label} must name dryRun:false as an executor`);
      assert.doesNotMatch(
        prose,
        /\(apply:true required to mutate\)/,
        `${label} must not claim apply:true is the only mutation trigger`,
      );
    }

    // F-014/F-015 RED: the enumerated list above went stale TWICE — first missing the per-flag
    // describe() strings (F-013), then missing the module header, the runtime dry-run note, and a
    // genuinely stale config.ts comment (F-014/F-015). A hand-maintained site list is the defect:
    // it silently under-covers every time someone documents this contract somewhere new. So DISCOVER
    // the sites instead of listing them — every non-test production line that talks about this
    // command's apply contract must also name dryRun:false. Adding a new mention anywhere now
    // either satisfies the contract or fails this check; it can no longer be silently missed.
    // F-016/F-017 RED: the first discovery sweep matched line-by-line with a regex, which gave it
    // three silent escapes, all confirmed by reviewers against the real logic: (1) the exclusion
    // pattern was whole-line, so fusing a stale claim onto a line containing `args.apply` or a
    // `+ '...'` continuation hid it entirely — and 3 real continuation lines carrying `apply:true`
    // were already being skipped; (2) the self-mention test read ONE line while the pairing test
    // read a ±3-line window, so a two-line comment naming the command above a stale claim was
    // invisible; (3) the window was not sentence-scoped, so a stale statement could borrow a
    // neighbour's correct `dryRun:false`. Line-oriented regex is simply the wrong instrument for
    // "is this prose unit self-consistent". Parse instead: every string literal (concatenations
    // folded into one unit) and every comment block IS a prose unit, so a claim and its pairing
    // are judged in the same unit they were written in, and executable logic is excluded because
    // it is neither a comment nor a string rather than because a regex guessed at it.
    const proseUnitsOf = (file: string, source: string): Array<{ text: string; line: number }> => {
      const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
      const units: Array<{ text: string; line: number }> = [];
      const lineOf = (pos: number) => sf.getLineAndCharacterOfPosition(pos).line + 1;
      const seenComments = new Set<number>();
      const collectComments = (pos: number) => {
        for (const range of [...(ts.getLeadingCommentRanges(source, pos) ?? []), ...(ts.getTrailingCommentRanges(source, pos) ?? [])]) {
          if (seenComments.has(range.pos)) continue;
          seenComments.add(range.pos);
          units.push({ text: source.slice(range.pos, range.end), line: lineOf(range.pos) });
        }
      };
      const visit = (node: ts.Node): void => {
        collectComments(node.getFullStart());
        // A `'a' + 'b' + 'c'` message is ONE prose unit; take the whole expression and do not
        // descend into its parts, so a claim on one operand pairs with text on another.
        if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken && /['"`]/.test(node.getText()[0] ?? '')) {
          units.push({ text: node.getText(), line: lineOf(node.getStart()) });
          return;
        }
        if (ts.isStringLiteralLike(node)) {
          units.push({ text: node.getText(), line: lineOf(node.getStart()) });
          return;
        }
        node.forEachChild(visit);
      };
      visit(sf);
      // F-018 RED: merging contiguous `//` lines into one block only moved the borrowing escape
      // from the old ±3-line window to the comment-block boundary — a stale sentence could still
      // borrow an unrelated sentence's `dryRun:false` from the same block, and quorum-prune.ts's
      // 20-line header is exactly such a multi-sentence block. Comments are therefore joined by
      // line-contiguity and then split back apart by SENTENCE, so each claim is judged against
      // the sentence that makes it. `apply:true`/`dryRun:false` contain no sentence-ending
      // period, so splitting on `.` followed by whitespace cannot cut a claim in half.
      units.sort((a, b) => a.line - b.line);
      const merged: Array<{ text: string; line: number }> = [];
      for (const unit of units) {
        const previous = merged[merged.length - 1];
        const contiguousComment = previous
          && unit.text.startsWith('//') && previous.text.startsWith('//')
          && unit.line === previous.line + previous.text.split('\n').length;
        if (contiguousComment) previous.text += `\n${unit.text}`;
        else merged.push({ ...unit });
      }
      return merged.flatMap((unit) => {
        if (!unit.text.startsWith('//') && !unit.text.startsWith('/*')) return [unit];
        const sentences = unit.text.split(/(?<=\.)\s+/).filter(sentence => sentence.trim().length > 0);
        if (sentences.length <= 1) return [unit];
        let consumed = 0;
        return sentences.map((sentence) => {
          const line = unit.line + unit.text.slice(0, consumed).split('\n').length - 1;
          consumed += sentence.length + 1;
          return { text: sentence, line };
        });
      });
    };
    // Scope: sibling commands (capability_release_backfill and friends) legitimately keep the
    // apply-only convention, so only THIS command's prose is swept. quorum-prune.ts is entirely
    // about this command; the catalog is narrowed to the quorum_prune entry; elsewhere the prose
    // unit itself must name the command — now judged per UNIT, not per line, closing escape (2).
    // F-019 RED: the file list was still hand-maintained, so proof-or-stop-cli.ts — a CHK-003 scope
    // touchpoint that already carries quorum_prune prose — was permanently invisible to the
    // sweep. That is the same stale-enumeration pattern as F-013/F-014/F-015, just moved up from
    // lines to files. The story's own signed scope contract already enumerates every file this
    // change may touch, so read THAT instead of restating it: a file entering the story's scope
    // now enters the sweep automatically, and a hand-edited list can no longer drift behind it.
    // F-021 RED: deriving from allowedModify+allowedCreate alone was still too narrow. A file can
    // also enter the story's real scope through an acknowledged expansion — cli-engine.ts did
    // exactly that for the F-001 fix, carries quorum_prune prose, and a stale claim planted there
    // left the suite fully green. The codebase's own isAcknowledged() (core/scope-contract.ts)
    // treats acknowledged paths as in-scope, so the sweep must union them too: "in this story's
    // scope" has one meaning, and this guard now uses the same one the scope checker does.
    // B-cc10: this reads the REAL repo's own story artifact, so it must resolve whichever
    // state-dir spelling exists on disk rather than pinning the deprecated one.
    const scopeContractPath = STATE_DIR_NAMES
      .map((dir) => join(IMPLEMENTATION_REPO_ROOT, `${dir}/story/actives/B-3144/scope-contract.json`))
      .find((candidate) => existsSync(candidate))
      ?? join(IMPLEMENTATION_REPO_ROOT, `${PROOF_OR_STOP_STATE_DIR}/story/actives/B-3144/scope-contract.json`);
    const scopeContract = JSON.parse(readFileSync(scopeContractPath, 'utf8')) as {
      allowedModify?: string[];
      allowedCreate?: string[];
      allowedTest?: string[];
      acknowledgements?: Array<{ paths?: string[] }>;
    };
    const historicalScopePathMap = new Map<string, string>([
      // B-3144's signed scope predates the clean-break handler rename. Preserve
      // that historical artifact and resolve its owned source path to the
      // canonical file the implementation now ships.
      [['packages/main/src/handlers/lat', 'tice-cli.ts'].join(''), 'packages/main/src/handlers/proof-or-stop-cli.ts'],
    ]);
    const sweptFiles = [...new Set([
      ...(scopeContract.allowedModify ?? []),
      ...(scopeContract.allowedCreate ?? []),
      ...(scopeContract.acknowledgements ?? []).flatMap(ack => ack.paths ?? []),
    ])]
      .filter(path => path.endsWith('.ts') && !(scopeContract.allowedTest ?? []).includes(path))
      .map(path => historicalScopePathMap.get(path) ?? path)
      .sort();
    assert.ok(sweptFiles.length >= 6, `scope contract yielded too few production files to sweep: ${sweptFiles.join(', ')}`);
    // The catalog is one giant multi-command file, so only the quorum_prune entry is in range;
    // quorum-prune.ts is entirely this command's, and everything else must name it nearby.
    const catalogRelPath = 'packages/main/src/cli/command-catalog.ts';
    const handlerRelPath = 'packages/main/src/handlers/quorum-prune.ts';
    const catalogBlockStart = catalogSource.indexOf("{ name: 'quorum_prune'");
    const contractSources: Array<{ file: string; source: string; requireSelfMention: boolean; range?: [number, number] }> = sweptFiles.map((file) => {
      const source = file === catalogRelPath ? catalogSource
        : file === handlerRelPath ? handlerSource
          : readFileSync(join(IMPLEMENTATION_REPO_ROOT, file), 'utf8');
      return {
        file,
        source,
        requireSelfMention: file !== catalogRelPath && file !== handlerRelPath,
        ...(file === catalogRelPath ? { range: [catalogBlockStart, catalogBlockStart + catalogBlock.length] as [number, number] } : {}),
      };
    });
    const discovered: string[] = [];
    for (const { file, source, requireSelfMention, range } of contractSources) {
      const inRange = (line: number): boolean => {
        if (!range) return true;
        const startLine = source.slice(0, range[0]).split('\n').length;
        const endLine = source.slice(0, range[1]).split('\n').length;
        return line >= startLine && line <= endLine;
      };
      const sourceLines = source.split('\n');
      // Scoping and pairing are deliberately different granularities. Pairing is judged INSIDE the
      // prose unit (strict — a claim cannot borrow a neighbour's wording). Scoping asks only "is
      // this prose about quorum_prune", and the command name often sits beside the unit rather
      // than inside it (`'quorum_prune', // <comment>`, or a `quorum_prune: {` key above a reason
      // string), so it is answered over the surrounding lines. Wide scoping under-skips; strict
      // pairing prevents escapes. Getting these backwards is what F-017 flagged.
      // F-020 RED: a fixed ±N-line window is not anchored to anything real, so a claim written
      // more than N lines from the `quorum_prune` key silently leaves the sweep. Anchor to the
      // enclosing syntactic entry instead — the property assignment, array element, or statement
      // the prose belongs to — so however that entry is formatted, prose inside it stays in range.
      const scopeSf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
      const namedNearby = (line: number): boolean => {
        const offset = scopeSf.getPositionOfLineAndCharacter(Math.max(0, line - 1), 0);
        // The question is "which command's entry owns this prose", so match the KEY, not the text.
        // F-022 RED: keeping only the innermost enclosing node answered it wrongly — reformat
        // `quorum_prune: { reason: '...apply:true...' }` across lines and the innermost node is
        // `reason:` itself, whose text lacks the command name, so the site left the sweep.
        // F-023 RED: widening that to "any ancestor whose TEXT contains quorum_prune" answered it
        // wrongly in the other direction — each of these files holds its whole command table in
        // ONE top-level statement, which trivially contains the name, so every row in the table
        // matched, including the sibling commands this sweep must leave alone.
        // A property whose KEY is the command name is exactly the entry that owns its own prose:
        // it encloses the reason string however that entry is wrapped, and a sibling entry keyed
        // `quorum_submit` never matches no matter what the enclosing table contains.
        let named = false;
        const visit = (node: ts.Node): void => {
          if (named) return;
          if (node.getFullStart() > offset || node.getEnd() < offset) return;
          if (ts.isPropertyAssignment(node) && node.name.getText().replace(/['"]/g, '') === 'quorum_prune') {
            named = true;
            return;
          }
          node.forEachChild(visit);
        };
        visit(scopeSf);
        if (named) return true;
        // Array-element style (`'quorum_prune', // comment`) has no per-entry node, so fall back
        // to the physical line, which is where that form always puts the name.
        return (sourceLines[line - 1] ?? '').includes('quorum_prune');
      };
      for (const unit of proseUnitsOf(file, source)) {
        if (!/apply:true|apply=true/.test(unit.text)) continue;
        if (!inRange(unit.line)) continue;
        if (requireSelfMention && !unit.text.includes('quorum_prune') && !namedNearby(unit.line)) continue;
        const where = `${file}:${unit.line}`;
        discovered.push(where);
        assert.match(
          unit.text,
          /dryRun:false|--dryRun=false/,
          `${where} documents apply:true without naming dryRun:false as the equivalent executor (prose unit: ${unit.text.slice(0, 160)})`,
        );
      }
    }
    // The floor guards against the sweep silently finding nothing (a parse or scoping regression).
    // It is pinned to the actual current count, so losing even one site trips it — a loose floor
    // was itself a review finding: at >= 6 with 12 real sites, half could vanish unnoticed.
    assert.ok(
      discovered.length >= 10,
      `discovery sweep under-covered: found only ${discovered.length} contract prose units (${discovered.join(', ')}); if a site was legitimately removed, lower this floor deliberately`,
    );
    // Both refusals must be documented wherever the per-flag contract is rendered, so the two
    // --help lines cannot disagree with each other or with the block above them again.
    for (const [label, prose] of [
      ['catalog dryRun describe()', fieldDescribe('dryRun')],
      ['catalog apply describe()', fieldDescribe('apply')],
      ['QuorumPruneArgs JSDoc', argsInterface],
    ] as const) {
      assert.match(prose, /apply:false/, `${label} must document the symmetric apply:false refusal`);
    }
    // And the rendered help itself, since that is what an operator actually reads.
    withFreshFixture((fixture) => {
      const help = runFixtureCli(fixture.root, ['quorum_prune', '--help']);
      const helpText = `${help.stdout}\n${help.stderr}`;
      const dryRunLine = helpText.split('\n').find(line => line.includes('--dryRun')) ?? '';
      const applyLine = helpText.split('\n').find(line => line.trim().startsWith('--apply')) ?? '';
      assert.match(dryRunLine, /dryRun:false/, `rendered --dryRun help is stale: ${dryRunLine}`);
      assert.match(applyLine, /dryRun:false/, `rendered --apply help is stale: ${applyLine}`);
    });
  },
  }),
  defineQuorumSmokeCase({
    id: "qsm-068",
    title: "quorum_prune refuses a non-pass duplicate group instead of laundering the round (F-024)",
    domain: "prune",
    shard: "prune",
    capabilities: [],
    callbackBound: true,
    registrationSource: "packages/main/src/tasks/quorum-submit-smoke-prune-cases.ts",
    run: () => {
    // F-024 RED: grouping by runId + host/session/key with NO look at `decision` or the required
    // binding fields makes this recovery command able to CHANGE a verdict. A decision=fail row
    // standing before a passing row with the same identities is a duplicate group like any other,
    // so the default keep-the-later-row rule deletes the FAIL — and core/host-independence.ts
    // stops reporting the round as invalid. A previously failed review becomes a passing quorum,
    // executed by a tool whose entire purpose is to restore an ALREADY-recorded quorum.
    withFreshFixture((fixture) => {
      recordReviewerPasses(fixture.registry);
      const first: any = fixture.registry.get('quorum_submit')!(quorumArgs());
      assert.equal(first.emittedCount, 6, 'baseline quorum emits 3 rounds x 2 hosts');
      const failedRunId = `${STORY_ID}-q-r1`;
      const collidingRunId = `${STORY_ID}-q-r2`;
      const { failVerdictId } = injectPrecedingFailVerdict(fixture, failedRunId);

      // Precondition: the FAIL genuinely invalidates its round AT THE CURRENT MATERIAL, so the
      // only thing standing between this log and a full 3x2 floor is that one row.
      const poisoned = quorumFloorRounds(fixture);
      assert.equal(poisoned.validRounds.length, 2, 'the failed round is not valid before any prune');
      assert.ok(
        poisoned.invalidRounds.some(round =>
          round.runId === failedRunId && round.reasons.some(reason => /non-pass verdict/.test(reason))),
        'the consumer invalidates the round because of the failing verdict',
      );

      // Projection must not even offer the group as prunable.
      const dry: any = fixture.registry.get('quorum_prune')!({ storyId: STORY_ID, json: true });
      if (dry.duplicateGroups.length > 0) {
        // Pre-fix path: execute exactly what the projection offered and report the CONSEQUENCE, so
        // the repro is un-gameable — the failure names the laundering, not just a shape mismatch.
        fixture.registry.get('quorum_prune')!({ storyId: STORY_ID, apply: true, json: true });
        const laundered = quorumFloorRounds(fixture);
        assert.fail(
          'quorum_prune offered the non-pass identity collision as prunable, and pruning it laundered the round: '
          + `validRounds=${laundered.validRounds.length} invalidRounds=${laundered.invalidRounds.length} `
          + `failedRoundNowValid=${laundered.validRounds.some(round => round.runId === failedRunId)} `
          + `failingVerdictStillCommitted=${committedHostVerdictLines(fixture).some(event => event.verdictId === failVerdictId)}`,
        );
      }
      assert.equal(dry.duplicateGroups.length, 0, 'a non-pass member makes the identity collision unprunable');
      assert.equal(dry.removedVerdictCount, 0, 'nothing is projected for removal');
      assert.equal(dry.refusedGroups.length, 1, 'the group is reported as refused, not silently dropped');
      assert.equal(dry.refusedGroups[0].runId, failedRunId, 'the refusal names the affected runId');
      assert.ok(
        dry.refusedGroups[0].verdictIds.includes(failVerdictId),
        `the refusal names the failing verdict: ${JSON.stringify(dry.refusedGroups[0])}`,
      );
      assert.ok(
        dry.refusedGroups[0].reasons.some((reason: string) => /decision=fail is not pass/.test(reason)),
        `the refusal states WHY it is unrecoverable: ${JSON.stringify(dry.refusedGroups[0].reasons)}`,
      );

      // Executing must refuse outright and leave every byte alone.
      const eventsPath = quorumProcessEventsPath(fixture);
      const beforeBytes = readFileSync(eventsPath);
      const beforeHead = git(fixture.root, ['rev-parse', 'HEAD']);
      assert.throws(
        () => fixture.registry.get('quorum_prune')!({ storyId: STORY_ID, apply: true, json: true }),
        /nothing to prune[\s\S]*REFUSED as outside the recoverable/,
        'execution refuses and names the refused group',
      );
      assert.deepEqual(readFileSync(eventsPath), beforeBytes, 'the failing verdict is still there, byte-identical');
      assert.equal(git(fixture.root, ['rev-parse', 'HEAD']), beforeHead, 'the refusal makes no commit');
      assert.equal(storyBackupFiles(fixture).length, 0, 'the refusal writes no backup');
      const afterRefusal = quorumFloorRounds(fixture);
      assert.equal(afterRefusal.validRounds.length, 2, 'the failed round is STILL not valid — no laundering happened');
      assert.ok(
        afterRefusal.invalidRounds.some(round => round.runId === failedRunId),
        'the round the reviewer failed stays failed',
      );

      // Fail-closed is PER GROUP: a genuine B-bf52 collision elsewhere in the same log is still
      // recoverable in the same call, so the hardening does not disable the recovery.
      // F-031: must pin to the REAL current material, not a synthetic drift string — B-f88e
      // declines to downgrade a stale-material duplicate that shares identity with an already-live
      // native-material verdict, so a synthetic string here is silently neutralized and never
      // actually poisons collidingRunId (the "genuinely poisoned round recovered" assertion below
      // would then hold vacuously even if quorum_prune's recovery were broken). Same fix as
      // injectPoisonedDuplicates (commit 5291d420dd).
      appendDuplicatesForRunId(fixture, collidingRunId, currentMaterialHash(fixture.root, 'HEAD', fixture.root)!);
      const applied: any = fixture.registry.get('quorum_prune')!({ storyId: STORY_ID, apply: true, json: true });
      assert.equal(applied.applied, true, 'the genuine collision is still recoverable');
      assert.equal(applied.removedVerdictCount, 2, 'only the two losing rows of the recoverable group are removed');
      assert.equal(applied.refusedGroups.length, 1, 'the unrecoverable group is still refused in the same call');
      assert.equal(applied.refusedGroups[0].runId, failedRunId);
      const finalRounds = quorumFloorRounds(fixture);
      assert.ok(
        finalRounds.validRounds.map(round => round.runId).includes(collidingRunId),
        'the genuinely poisoned round recovered',
      );
      assert.ok(
        finalRounds.invalidRounds.some(round => round.runId === failedRunId),
        'and the failed round is still invalid after a successful apply on its neighbour',
      );
      assert.ok(
        committedHostVerdictLines(fixture).some(event => event.verdictId === failVerdictId),
        'the failing verdict row survives a successful prune of another group',
      );
    });
  },
  }),
  defineQuorumSmokeCase({
    id: "qsm-069",
    title: "quorum_prune never deletes a verdict cache path outside the story verdict dir (F-025)",
    domain: "prune",
    shard: "prune",
    capabilities: [],
    callbackBound: true,
    registrationSource: "packages/main/src/tasks/quorum-submit-smoke-prune-cases.ts",
    run: () => {
    // F-025 RED: the losing rows' verdictIds come from a committed log, i.e. untrusted input, and
    // were joined straight into `<verdictId>.json`. A crafted id resolves out of the gitignored
    // verdict cache and rmSync deletes a real repository file — after the evidence commit, so the
    // command reports a successful recovery while destroying an unrelated tracked file.
    withFreshFixture((fixture) => {
      recordReviewerPasses(fixture.registry);
      fixture.registry.get('quorum_submit')!(quorumArgs());
      write(fixture.root, 'evidence-target.json', '{"do-not":"delete me"}\n');
      git(fixture.root, ['add', '-A']);
      git(fixture.root, [...COMMIT_ENV, 'commit', '-m', 'a tracked file the traversal would destroy']);
      const target = join(fixture.root, 'evidence-target.json');
      const targetBytes = readFileSync(target);
      const verdictDir = join(fixture.root, PROOF_OR_STOP_STATE_DIR, 'autopilot-verdicts', STORY_ID);
      // The crafted id resolves to <root>/evidence-target.json from inside the verdict cache dir.
      const craftedVerdictId = '../../../evidence-target';
      const targetRunId = `${STORY_ID}-q-r1`;
      // F-031: pin to the REAL current material (see the identical fix + rationale at the F-024
      // check above and in injectPoisonedDuplicates, commit 5291d420dd) so the duplicate genuinely
      // collides instead of being silently neutralized by B-f88e's downgrade-skip.
      appendDuplicatesForRunId(
        fixture,
        targetRunId,
        currentMaterialHash(fixture.root, 'HEAD', fixture.root)!,
        event => ({ ...event, verdictId: craftedVerdictId }),
      );
      assert.equal(
        join(verdictDir, `${craftedVerdictId}.json`).replace(/\/+/g, '/'),
        join(fixture.root, 'evidence-target.json'),
        'fixture precondition: the crafted id really does traverse out of the verdict cache dir',
      );
      // keep:oldest-material makes the LATER (crafted) rows the losing set, so the crafted id is
      // the one handed to the verdict-cache deletion.
      const applied: any = fixture.registry.get('quorum_prune')!({
        storyId: STORY_ID, apply: true, keep: 'oldest-material', json: true,
      });
      assert.equal(applied.applied, true, 'the prune itself still succeeds');
      assert.ok(
        applied.removedVerdictIds.includes(craftedVerdictId),
        'the crafted id really was in the losing set handed to the cache deletion',
      );
      assert.ok(existsSync(target), 'the tracked file outside the verdict cache still exists');
      assert.deepEqual(readFileSync(target), targetBytes, 'and its bytes are untouched');
      assert.ok(
        applied.skippedVerdictFiles.some((skipped: any) =>
          skipped.verdictId === craftedVerdictId && /canonical generated shape/.test(skipped.reason)),
        `the skipped deletion is reported: ${JSON.stringify(applied.skippedVerdictFiles)}`,
      );
      for (const path of applied.removedVerdictFiles) {
        assert.equal(dirname(path), verdictDir, `deleted cache file stayed inside the verdict dir: ${path}`);
      }
      assert.equal(
        git(fixture.root, ['status', '--porcelain=v1', '--untracked-files=all']),
        '',
        'no tracked file was deleted, so the worktree is still clean after the apply',
      );
    });
  },
  }),
  defineQuorumSmokeCase({
    id: "qsm-070",
    title: "quorum_prune holds the shared append lock across read and rewrite (F-026)",
    domain: "prune",
    shard: "prune",
    capabilities: [],
    callbackBound: true,
    registrationSource: "packages/main/src/tasks/quorum-submit-smoke-prune-cases.ts",
    run: () => {
    // F-026 RED: the source bytes were read at the TOP of the handler — before the clean checks and
    // the transaction capture — and the rewrite never took the append lock ordinary process-event
    // writers must take (core/process-events.ts). Any row appended between that read and the
    // rewrite is silently overwritten, and the catch-path restore of the earlier snapshot deletes
    // it outright. The hook below fires at the start of the mutation phase and scripts exactly that
    // interleaving: a competing writer that lands (and commits) a row just before the rewrite.
    withFreshFixture((fixture) => {
      injectPoisonedDuplicates(fixture);
      const eventsPath = quorumProcessEventsPath(fixture);
      const expectedLockDir = storyRuntimeLockPath(fixture.root, 'process-events', STORY_ID, 'process-events-append');
      const concurrentRow = JSON.stringify({
        type: 'review_run',
        marker: 'B-3144-F-026-concurrent-append',
        reviewRunId: 'B-3144-F-026',
      });
      let observedLockDir = '';
      let contention: unknown = null;
      const prune = createQuorumPruneHandlers(fixture.ctx, {
        insideAppendLock: ({ lockDir }) => {
          observedLockDir = lockDir;
          // (1) The lock is genuinely HELD at this moment: an independent fail-fast acquire of the
          // SAME dir must be refused. Without the fix this acquire simply succeeds.
          try {
            acquireMkdirLock(lockDir, {
              failFastIfHeld: true,
              heldMessage: 'process-events append lock is held',
            }).release();
          } catch (error) {
            contention = error;
          }
          // (2) A row that landed just before the lock was taken must survive the rewrite.
          appendFileSync(eventsPath, `${concurrentRow}\n`, 'utf8');
          git(fixture.root, ['add', '-A']);
          git(fixture.root, [...COMMIT_ENV, 'commit', '-m', 'concurrent append that must survive the prune']);
        },
      }).quorum_prune;
      const applied: any = prune({ storyId: STORY_ID, apply: true, json: true });
      assert.equal(observedLockDir, expectedLockDir, 'prune takes the SAME lock the append primitive takes');
      assert.ok(contention, 'the append lock was genuinely held while the rewrite ran');
      assert.match(String((contention as Error).message), /held/i, String((contention as Error).message));
      assert.equal(applied.applied, true);
      assert.equal(applied.removedVerdictCount, 6, 'the recovery still removed the losing duplicate set');
      const afterLines = readFileSync(eventsPath, 'utf8').split('\n');
      assert.ok(
        afterLines.includes(concurrentRow),
        'the row committed by the competing writer survives the rewrite instead of being overwritten',
      );
      assert.ok(
        readFileSync(applied.backupPath, 'utf8').includes('B-3144-F-026-concurrent-append'),
        'the backup is a copy of the bytes the rewrite was actually derived from, not an older snapshot',
      );
      assert.equal(
        git(fixture.root, ['status', '--porcelain=v1', '--untracked-files=all']),
        '',
        'the committed rewrite leaves a clean tree',
      );
      assert.equal(quorumFloorRounds(fixture).validRounds.length, 3, 'the floor still recovers to full 3x2');
    });
  },
  }),
  defineQuorumSmokeCase({
    id: "qsm-071",
    title: "quorum_prune installs the pruned log by atomic rename, never an in-place overwrite (F-027)",
    domain: "prune",
    shard: "prune",
    capabilities: [],
    callbackBound: true,
    registrationSource: "packages/main/src/tasks/quorum-submit-smoke-prune-cases.ts",
    run: () => {
    // F-027 RED: the rewrite was a plain in-place writeFileSync, which truncates first. A SIGKILL
    // or power loss between the truncate and the final write leaves a PARTIAL canonical log and the
    // catch-path rollback never runs, while the surrounding prose called the operation atomic. The
    // inode assertion below is the mechanical difference: an in-place overwrite keeps the file's
    // identity, a temp-file-plus-rename replaces it.
    withFreshFixture((fixture) => {
      injectPoisonedDuplicates(fixture);
      const eventsPath = quorumProcessEventsPath(fixture);
      const before = statSync(eventsPath);
      assert.ok(before.ino > 0, 'inode identity is observable on this filesystem, so the check is not vacuous');
      const applied: any = fixture.registry.get('quorum_prune')!({ storyId: STORY_ID, apply: true, json: true });
      assert.equal(applied.applied, true);
      const after = statSync(eventsPath);
      assert.notEqual(
        after.ino,
        before.ino,
        'the canonical log was REPLACED by a rename; an in-place truncate-and-write keeps the same inode',
      );
      assert.equal(storyBackupFiles(fixture).length, 1, 'only the backup remains — the rewrite temp was renamed away');
      assert.equal(
        git(fixture.root, ['status', '--porcelain=v1', '--untracked-files=all']),
        '',
        'no rewrite temp survives as worktree dirt',
      );
      const handlerSource = readFileSync(join(IMPLEMENTATION_REPO_ROOT, 'packages/main/src/handlers/quorum-prune.ts'), 'utf8');
      assert.match(handlerSource, /renameSync\(tempPath, processEventsPath\)/, 'the rewrite installs through rename');
      assert.match(handlerSource, /fsyncSync\(fd\)/, 'the replacement bytes are flushed before the rename');
      assert.doesNotMatch(
        handlerSource,
        /writeFileSync\(processEventsPath/,
        'the canonical log is never written in place, so the atomicity the prose claims is real',
      );
    });
  },
  })
];
