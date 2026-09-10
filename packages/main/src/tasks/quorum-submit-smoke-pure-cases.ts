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
    id: "qsm-002",
    title: "reviewer provider mapping is explicit and unsupported providers fail closed",
    domain: "pure",
    shard: "pure",
    capabilities: [],
    callbackBound: true,
    registrationSource: "packages/main/src/tasks/quorum-submit-smoke-pure-cases.ts",
    run: () => {
    assert.equal(reviewerPromptHostForProvider('codex'), 'codex');
    assert.equal(reviewerPromptHostForProvider('codex-cli'), 'codex');
    assert.equal(reviewerPromptHostForProvider('claude-code'), 'claude');
    assert.equal(reviewerPromptHostForProvider('claude-cli'), 'claude');
    for (const provider of ['antigravity', 'fake', 'unknown', undefined] as const) {
      assert.throws(
        () => reviewerPromptHostForProvider(provider),
        new RegExp(`unsupported session host provider "${provider ?? 'absent'}"`),
      );
    }
  },
  }),
  defineQuorumSmokeCase({
    id: "qsm-003",
    title: "explicit invalid provider wins over competing host inference while true absence still infers",
    domain: "pure",
    shard: "pure",
    capabilities: [],
    callbackBound: true,
    registrationSource: "packages/main/src/tasks/quorum-submit-smoke-pure-cases.ts",
    prepare: legacy.prepareCurrentRootContext,
    run: ({ context: { root } }: { context: { root: string } }) => {
    const inputs = { hostname: 'quorum-smoke-host', root, ppid: 4242 };
    for (const competingEnv of [
      { CODEX_THREAD_ID: 'competing-codex-thread' },
      { CLAUDE_CODE_SESSION_ID: 'competing-claude-session' },
    ]) {
      const invalid = resolveSessionIdentity({
        PROOF_OR_STOP_SESSION_ID: 'sess-explicit-invalid',
        PROOF_OR_STOP_OWNER_SESSION_ADAPTER_PROVIDER: 'gemini',
        ...competingEnv,
      }, inputs);
      assert.equal(invalid.hostProvider, 'unknown', 'explicit invalid provider cannot fall through to competing host variables');
      assert.equal(invalid.sessionSource, 'explicit-env');
    }
    const absentCodex = resolveSessionIdentity({
      PROOF_OR_STOP_SESSION_ID: 'sess-absent-codex',
      CODEX_THREAD_ID: 'inferred-codex-thread',
    }, inputs);
    assert.equal(absentCodex.hostProvider, 'codex', 'absent explicit provider preserves Codex inference');
    const absentClaude = resolveSessionIdentity({
      PROOF_OR_STOP_SESSION_ID: 'sess-absent-claude',
      CLAUDE_CODE_SESSION_ID: 'inferred-claude-session',
    }, inputs);
    assert.equal(absentClaude.hostProvider, 'claude-code', 'absent explicit provider preserves Claude inference');
  },
  }),
  defineQuorumSmokeCase({
    id: "qsm-009",
    title: "shared binding derivation is byte-identical to the former quorum envelopes",
    domain: "pure",
    shard: "pure",
    capabilities: [],
    callbackBound: true,
    registrationSource: "packages/main/src/tasks/quorum-submit-smoke-pure-cases.ts",
    sentinel: "real",
    run: () => {
    const vector = {
      storyId: STORY_ID,
      headHash: 'head-vector',
      materialDigest: 'material-vector',
      storyFilesHash: 'story-files-vector',
      testEvidence: { result: 'PASS', command: 'vector' },
      hostId: 'host-vector',
      provider: 'codex',
      sessionId: 'session-vector',
    };
    const keyId = `quorum:${STORY_ID}:host-vector:key`;
    const actual = deriveHostVerdictBindings(vector);
    assert.equal(actual.keyId, keyId);
    assert.equal(actual.keyId, deriveCanonicalHostKeyId(STORY_ID, 'host-vector'));
    assert.equal(actual.validationDigest, canonicalDigest({
      schemaVersion: 'proof-or-stop.quorum_submit.validation_digest.v1',
      storyId: STORY_ID,
      headHash: 'head-vector',
      materialDigest: 'material-vector',
      storyFilesHash: 'story-files-vector',
      testEvidence: vector.testEvidence,
    }));
    assert.equal(actual.promptDigest, canonicalDigest({
      schemaVersion: 'proof-or-stop.quorum_submit.prompt_digest.v1',
      purpose: 'local voluntary 3x2 review quorum after signed reviewer passes',
      storyId: STORY_ID,
      hostId: 'host-vector',
      provider: 'codex',
      sessionId: 'session-vector',
      keyId,
      materialDigest: 'material-vector',
      storyFilesHash: 'story-files-vector',
    }));
    assert.equal(HOST_VERDICT_VALIDATION_DIGEST_SCHEMA, 'proof-or-stop.quorum_submit.validation_digest.v1');
    assert.equal(HOST_VERDICT_PROMPT_DIGEST_SCHEMA, 'proof-or-stop.quorum_submit.prompt_digest.v1');
    assert.equal(HOST_VERDICT_PROMPT_PURPOSE, 'local voluntary 3x2 review quorum after signed reviewer passes');
  },
  }),
  defineQuorumSmokeCase({
    id: "qsm-010",
    title: "shared derivation preserves optional-head and missing-evidence envelopes",
    domain: "pure",
    shard: "pure",
    capabilities: [],
    callbackBound: true,
    registrationSource: "packages/main/src/tasks/quorum-submit-smoke-pure-cases.ts",
    run: () => {
    const base = {
      storyId: STORY_ID,
      materialDigest: 'material-vector',
      storyFilesHash: 'story-files-vector',
      hostId: 'host-vector',
      provider: 'codex',
      sessionId: 'session-vector',
    };
    const absent = deriveHostVerdictBindings({ ...base, testEvidence: null });
    assert.equal(absent.validationDigest, canonicalDigest({
      schemaVersion: 'proof-or-stop.quorum_submit.validation_digest.v1',
      storyId: STORY_ID,
      headHash: undefined,
      materialDigest: 'material-vector',
      storyFilesHash: 'story-files-vector',
      testEvidence: null,
    }));
    const present = deriveHostVerdictBindings({ ...base, headHash: 'head-vector', testEvidence: { result: 'PASS' } });
    assert.notEqual(absent.validationDigest, present.validationDigest);
  },
  }),
  defineQuorumSmokeCase({
    id: "qsm-011",
    title: "shared derivation fails closed on every required envelope field",
    domain: "pure",
    shard: "pure",
    capabilities: [],
    callbackBound: true,
    registrationSource: "packages/main/src/tasks/quorum-submit-smoke-pure-cases.ts",
    run: () => {
    const valid = {
      storyId: STORY_ID,
      materialDigest: 'material-vector',
      storyFilesHash: 'story-files-vector',
      testEvidence: null,
      hostId: 'host-vector',
      provider: 'codex',
      sessionId: 'session-vector',
      keyId: 'key-vector',
    };
    for (const field of ['storyId', 'materialDigest', 'storyFilesHash', 'hostId', 'provider', 'sessionId', 'keyId'] as const) {
      assert.throws(() => deriveHostVerdictBindings({ ...valid, [field]: ' ' }), new RegExp(field));
    }
    assert.throws(() => deriveHostVerdictBindings({ ...valid, storyId: '../not-a-story' }), /canonical storyId/);
    assert.throws(() => deriveCanonicalHostKeyId('../not-a-story', 'host-vector'), /canonical storyId/);
  },
  }),
  defineQuorumSmokeCase({
    id: "qsm-012",
    title: "shared derivation binds every replay-sensitive input",
    domain: "pure",
    shard: "pure",
    capabilities: [],
    callbackBound: true,
    registrationSource: "packages/main/src/tasks/quorum-submit-smoke-pure-cases.ts",
    run: () => {
    const base = {
      storyId: STORY_ID,
      headHash: 'head-vector',
      materialDigest: 'material-vector',
      storyFilesHash: 'story-files-vector',
      testEvidence: { result: 'PASS' },
      hostId: 'host-vector',
      provider: 'codex',
      sessionId: 'session-vector',
      keyId: 'key-vector',
    };
    const original = deriveHostVerdictBindings(base);
    for (const [field, value] of Object.entries({
      storyId: 'B-other', headHash: 'other-head', materialDigest: 'other-material',
      storyFilesHash: 'other-story-files', hostId: 'other-host', provider: 'claude',
      sessionId: 'other-session', keyId: 'other-key',
    })) {
      const changed = deriveHostVerdictBindings({ ...base, [field]: value });
      assert.ok(changed.validationDigest !== original.validationDigest || changed.promptDigest !== original.promptDigest, `${field} changes a canonical digest`);
    }
    const changedEvidence = deriveHostVerdictBindings({ ...base, testEvidence: { result: 'FAIL' } });
    assert.notEqual(changedEvidence.validationDigest, original.validationDigest);
  },
  })
];
