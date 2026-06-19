#!/usr/bin/env node
/**
 * @task B-b710
 * @checklist CHK-001, CHK-002
 * @title authority status / conduit status readiness smoke
 * @type chore
 * @priority high
 * @description
 *   Smoke coverage for Lattice CLI 0.3.5 enforce readiness diagnostics
 *   (B-b710 milestones 3-4). Verifies:
 *
 *   Happy / off mode:
 *     - `lattice authority status --json` and `lattice authority status --format=json`
 *       both work and report mode="off", localWorkflowUsable=true,
 *       productionDone=false, receiptVerified=false, canClaimProductionDone=false,
 *       readinessWarnings=[] (off is intentional opt-out, not a misconfig).
 *
 *   Edge / shadow + missing prerequisites:
 *     - shadow without LATTICE_AUTHORITY_URL surfaces actionable readinessWarnings
 *       and nextActions, but keeps localWorkflowUsable=true and productionDone=false.
 *
 *   Edge / enforce + missing prerequisites:
 *     - enforce without URL / actor key / runner id surfaces three readiness
 *       warnings; localWorkflowUsable=true and productionDone=false remain.
 *
 *   Edge / enforce with all env prerequisites set:
 *     - Even when URL, actor key, and runner id are all set, productionDone /
 *       receiptVerified / canClaimProductionDone remain false when no stored
 *       production receipt ref exists — env presence alone is not authority.
 *
 *   Adversarial:
 *     - No combination of env vars / overrides can flip productionDone or
 *       canClaimProductionDone to true.
 *     - conduit_status mirrors the same readiness fields and the same negative
 *       authority guarantees.
 *
 *   Boundary preserved by this story:
 *     - No actor key generation, no job claim, no provider execution, no signed
 *       envelope, no receipt verification, no L2+ promotion are introduced.
 *     - Env vars (LATTICE_AUTHORITY_ACTOR_KEY / LATTICE_AUTHORITY_RUNNER_ID etc.)
 *       are presence-only diagnostics; the CLI never *uses* them to do anything.
 * @changes
 *   Add focused smoke coverage for B-b710 enforce readiness diagnostics
 *   exposed by `authority_status` and `conduit_status`, including the
 *   adversarial guarantee that no readiness combination promotes productionDone
 *   away from `false` without a verified receipt.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildAuthorityStatus,
  buildConduitStatus,
} from '../handlers/lattice-cli.js';
import { DEFAULT_AUTHORITY_TRUST_PROFILE_FILE_NAMES } from '../core/authority-mode.js';
import { currentGitHead, currentMaterialHash } from '../core/evidence-freshness.js';
import { upsertAuthorityGateReceiptRef, type AuthorityGateDecisionReceiptRef } from '../core/authority-gate-receipts.js';
import { StoryStore } from '../core/store.js';
import type { ChecklistData, StoryInfo } from '../core/types.js';

const here = dirname(fileURLToPath(import.meta.url));
const cliPath = join(here, '..', 'cli.js');
const repoRoot = join(here, '..', '..', '..', '..');

type EnvOverride = Record<string, string | undefined>;

function runJsonAtRoot<T>(root: string, args: string[], env: EnvOverride = {}, cwd = root): T {
  const out = execFileSync(process.execPath, [cliPath, '--root', root, ...args], {
    cwd,
    env: { ...process.env, ...env },
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  return JSON.parse(out) as T;
}

function runJson<T>(args: string[], env: EnvOverride = {}): T {
  return runJsonAtRoot<T>(repoRoot, args, env, repoRoot);
}

function runText(args: string[], env: EnvOverride = {}): string {
  return execFileSync(process.execPath, [cliPath, '--root', repoRoot, ...args], {
    cwd: repoRoot,
    env: { ...process.env, ...env },
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

/**
 * Walk the JSON tree and ensure status/readiness output cannot claim production
 * completion or mutate authority. CHK-006 allows receiptVerified=true only when
 * a stored production receipt ref is present; env-only and local-test paths keep
 * explicit receiptVerified=false assertions below.
 */
function assertNoProductionOverclaim(value: unknown, label: string): void {
  const seen: string[] = [];
  const visit = (node: unknown, path: string): void => {
    if (node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      node.forEach((item, i) => visit(item, `${path}[${i}]`));
      return;
    }
    for (const [k, child] of Object.entries(node as Record<string, unknown>)) {
      const childPath = path ? `${path}.${k}` : k;
      if (
        (k === 'productionDone' ||
          k === 'canClaimProductionDone' ||
          k === 'authorityChanged') &&
        child === true
      ) {
        seen.push(childPath);
      }
      visit(child, childPath);
    }
  };
  visit(value, '');
  assert.deepEqual(
    seen,
    [],
    `${label} must not contain production/authority true overclaims`,
  );
}

// Helper: only inject mode + prerequisite envs; never inherit ambient ones.
const EMPTY_AUTHORITY_ENV: EnvOverride = {
  LATTICE_AUTHORITY_MODE: '',
  LATTICE_AUTHORITY_URL: '',
  LATTICE_AUTHORITY_TIMEOUT_MS: '',
  LATTICE_AUTHORITY_ACTOR_KEY: '',
  LATTICE_AUTHORITY_ACTOR_KEY_PATH: '',
  LATTICE_AUTHORITY_RUNNER_ID: '',
  LATTICE_AUTHORITY_SESSION_ID: '',
  LATTICE_AUTHORITY_TRUST_ENV_FILE: '.missing-authority-trust.env',
};
const NOW = '2026-06-10T00:00:00.000Z';

function git(root: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
}

function makeRoot(): { root: string; store: StoryStore } {
  const root = mkdtempSync(join(tmpdir(), 'authority-status-'));
  mkdirSync(join(root, 'packages', 'main', 'src'), { recursive: true });
  writeFileSync(join(root, 'packages', 'main', 'src', 'index.ts'), 'export const value = 1;\n');
  writeFileSync(join(root, 'lattice.config.json'), `${JSON.stringify({
    scanRoot: 'packages/main',
    rootDir: 'src',
    outDir: 'packages/main/dist',
    testsDir: 'packages/main/tests',
    fixturesDir: 'packages/main/tests/fixtures',
    storyDir: '.lattice/story/actives',
    requirementsDir: 'docs/requirements',
    storyPrefix: 'B',
    workflow: { profile: 'balanced' },
  }, null, 2)}\n`);
  git(root, ['init']);
  git(root, ['config', 'user.email', 'test@example.invalid']);
  git(root, ['config', 'user.name', 'Authority Status Smoke']);
  git(root, ['add', 'lattice.config.json', 'packages/main/src/index.ts']);
  git(root, ['commit', '-m', 'seed']);
  return { root, store: new StoryStore(root) };
}

function seedStory(store: StoryStore, storyId: string): void {
  const story: StoryInfo = {
    storyId,
    name: storyId.toLowerCase(),
    title: 'Authority status smoke story',
    description: 'Temporary story used to verify authority status receipt facts.',
    type: 'feature',
    phase: 'DEV',
    priority: 'medium',
    createdAt: NOW,
    startedAt: null,
    endedAt: null,
    events: [],
  };
  store.writeStory(storyId, story);
  const checklist: ChecklistData = {
    items: [{
      id: 'CHK-001',
      title: 'done',
      status: 'done',
      startTime: NOW,
      endTime: NOW,
    }],
  };
  store.writeChecklist(storyId, checklist);
}

function refFor(
  root: string,
  storyId: string,
  overrides: Partial<AuthorityGateDecisionReceiptRef> = {},
): AuthorityGateDecisionReceiptRef {
  const headHash = currentGitHead(root);
  const materialHash = currentMaterialHash(root);
  assert.ok(headHash, 'smoke repo must have git HEAD');
  assert.ok(materialHash, 'smoke repo must have material hash');
  return {
    receiptId: 'AR-STATUS',
    receiptKind: 'gate_decision',
    classification: 'production-gate-decision',
    authorityUrl: 'https://authority.example',
    authorityKeyId: 'server-key-1',
    authorityPublicKeyDigest: 'sha256:key',
    decisionId: 'GD-STATUS',
    stateVersion: 7,
    gateInputDigest: 'sha256:input',
    decisionDigest: 'sha256:decision',
    decisionVerdict: 'pass',
    storyId,
    targetPhase: 'TEST',
    headHash,
    materialHash,
    policyMode: 'balanced',
    authorityMode: 'enforce',
    producerRunIds: ['run-producer-1'],
    verifierRunIds: ['run-verifier-1'],
    runnerSessionIds: ['session-1'],
    evidenceDigests: ['sha256:evidence-1'],
    verifiedAt: NOW,
    verifiedBy: 'lattice authority receipt verify',
    eligibleGates: ['TEST'],
    status: 'active',
    consumptionEvents: [],
    ...overrides,
  };
}

// ── Pure-function unit checks (in-process, no env crosstalk) ────────────────

// Off mode: no readiness warnings, productionDone false, mode === 'off'.
{
  const result = buildAuthorityStatus({}, { ...EMPTY_AUTHORITY_ENV } as Record<string, string | undefined>);
  assert.equal(result.mode, 'off', 'off-mode mode is off');
  assert.equal(result.authorityMode, 'off', 'off-mode authorityMode alias is off');
  assert.equal(result.localWorkflowUsable, true, 'off-mode localWorkflowUsable is true');
  assert.equal(result.productionDone, false, 'off-mode productionDone is false');
  assert.equal(result.receiptVerified, false, 'off-mode receiptVerified is false');
  assert.equal(result.canClaimProductionDone, false, 'off-mode canClaimProductionDone is false');
  assert.equal(result.authorityUrlConfigured, false, 'off-mode authorityUrlConfigured is false');
  assert.equal(result.customerApiKeyConfigured, false, 'off-mode customer key is not configured');
  assert.equal(result.customerApiKeySource, 'missing', 'off-mode customer key source is missing');
  assert.equal(result.customerApiKeyValid, 'unknown', 'customer key validity is never inferred locally');
  assert.equal(result.actorKeyConfigured, false, 'off-mode actorKeyConfigured is false');
  assert.equal(result.actorKeyRegistered, 'unknown', 'actor registration requires a live probe');
  assert.equal(result.serverPublicKeyPinned, false, 'off-mode server key is not pinned');
  assert.equal(result.runnerConfigured, false, 'off-mode runnerConfigured is false');
  assert.equal(result.productionAuthorityUsable, false, 'status output never claims production authority usability');
  assert.deepEqual(result.readinessWarnings, [], 'off-mode emits no readiness warnings');
  assert.deepEqual(result.nextActions, [], 'off-mode emits no next actions');
  assert.match(result.localWorkflowNote, /readiness warnings, not global blockers/i, 'off-mode includes local-workflow note');
  assert.match(result.localWorkflowNote, /target workspace/i, 'off-mode note says the bundle is generated locally on the target workspace');
  assertNoProductionOverclaim(result, 'buildAuthorityStatus off-mode');
}

// Off mode performs zero trust-file / secret-file reads, even if a trust file is configured.
{
  const reads: string[] = [];
  const result = buildAuthorityStatus(
    {},
    {
      ...EMPTY_AUTHORITY_ENV,
      LATTICE_AUTHORITY_MODE: 'off',
      LATTICE_AUTHORITY_TRUST_ENV_FILE: 'authority_trust.env',
    } as Record<string, string | undefined>,
    {
      cwd: '/proj',
      fileReader: p => {
        reads.push(p);
        if (p.endsWith('authority_trust.env')) {
          return [
            'LATTICE_AUTHORITY_LIVE_URL=https://off-mode-trust.example',
            'LATTICE_AUTHORITY_CUSTOMER_API_KEY_FILE=secrets/customer.key',
          ].join('\n');
        }
        if (p.endsWith('secrets/customer.key')) return 'secret-key';
        return undefined;
      },
    },
  );
  assert.deepEqual(reads, [], 'off mode does not read authority_trust.env or referenced secret files');
  assert.equal(result.mode, 'off', 'off-mode remains off');
  assert.equal(result.authorityTrustEnvLoaded, false, 'off mode does not load root trust env');
  assert.equal(result.customerApiKeyConfigured, false, 'off mode does not configure customer key from trust env');
  assert.equal(result.customerApiKeySource, 'missing', 'off-mode customer source remains missing');
  assertNoProductionOverclaim(result, 'buildAuthorityStatus off-mode-zero-trust-io');
}

// Shadow + missing URL: warning fired, productionDone still false.
{
  const env: EnvOverride = { ...EMPTY_AUTHORITY_ENV, LATTICE_AUTHORITY_MODE: 'shadow' };
  const result = buildAuthorityStatus({}, env as Record<string, string | undefined>);
  assert.equal(result.mode, 'shadow', 'shadow mode reported');
  assert.equal(result.localWorkflowUsable, true, 'shadow-missing-url localWorkflowUsable true');
  assert.ok(
    result.readinessWarnings.some(w => /shadow.*LATTICE_AUTHORITY_URL/.test(w)),
    'shadow + missing URL emits actionable readiness warning',
  );
  assert.ok(
    result.nextActions.some(a => /LATTICE_AUTHORITY_URL/.test(a)),
    'shadow + missing URL suggests setting LATTICE_AUTHORITY_URL',
  );
  assert.equal(result.productionDone, false, 'shadow productionDone still false');
  assert.equal(result.canClaimProductionDone, false, 'shadow canClaimProductionDone still false');
  assertNoProductionOverclaim(result, 'buildAuthorityStatus shadow-missing-url');
}

// Enforce + localhost default + missing customer key + missing actor key + missing runner.
{
  const env: EnvOverride = { ...EMPTY_AUTHORITY_ENV, LATTICE_AUTHORITY_MODE: 'enforce' };
  const result = buildAuthorityStatus({}, env as Record<string, string | undefined>);
  assert.equal(result.mode, 'enforce', 'enforce mode reported');
  assert.equal(result.localWorkflowUsable, true, 'enforce-missing-prereqs localWorkflowUsable true');
  assert.equal(result.authorityUrlConfigured, true, 'enforce mode sees the localhost authority default');
  assert.equal(result.defaultUrlApplied, true, 'enforce mode records the localhost default source');
  assert.ok(result.productionInert, 'localhost authority default is production-inert');
  assert.ok(
    result.readinessWarnings.some(w => /LATTICE_AUTHORITY_CUSTOMER_API_KEY/.test(w)),
    'enforce + missing customer key emits customer key warning',
  );
  assert.ok(
    result.readinessWarnings.some(w => /LATTICE_AUTHORITY_ACTOR_KEY/.test(w)),
    'enforce + missing actor key emits actor key warning',
  );
  assert.ok(
    result.readinessWarnings.some(w => /runner/i.test(w) && /LATTICE_AUTHORITY_RUNNER_ID/.test(w)),
    'enforce + missing runner id emits runner readiness warning',
  );
  assert.equal(result.productionDone, false, 'enforce productionDone still false');
  assert.equal(result.receiptVerified, false, 'enforce receiptVerified still false');
  assert.equal(result.canClaimProductionDone, false, 'enforce canClaimProductionDone still false');
  assertNoProductionOverclaim(result, 'buildAuthorityStatus enforce-missing-prereqs');
}

// Enforce with all env prerequisites set: still NOT productionDone.
{
  const env: EnvOverride = {
    ...EMPTY_AUTHORITY_ENV,
    LATTICE_AUTHORITY_MODE: 'enforce',
    LATTICE_AUTHORITY_URL: 'https://authority.example',
    LATTICE_AUTHORITY_CUSTOMER_API_KEY: 'customer-key-canary',
    LATTICE_AUTHORITY_SERVER_PUBLIC_KEY: 'server-public-key-canary',
    LATTICE_AUTHORITY_ACTOR_KEY: 'fake-key-blob',
    LATTICE_AUTHORITY_RUNNER_ID: 'runner-1',
    LATTICE_AUTHORITY_SESSION_ID: 'session-1',
  };
  const result = buildAuthorityStatus({}, env as Record<string, string | undefined>);
  assert.equal(result.mode, 'enforce', 'enforce reported even when env complete');
  assert.equal(result.authorityUrlConfigured, true, 'authority URL detected');
  assert.equal(result.customerApiKeyConfigured, true, 'customer API key detected');
  assert.equal(result.customerApiKeySource, 'env', 'customer API key source reported');
  assert.equal(result.customerApiKeyValid, 'unknown', 'customer API key is not treated as validated by local status');
  assert.equal(result.actorKeyConfigured, true, 'actor key detected');
  assert.equal(result.actorKeyRegistered, 'unknown', 'actor registration is not inferred from local config');
  assert.equal(result.serverPublicKeyPinned, true, 'server public key pin is detected');
  assert.equal(result.runnerConfigured, true, 'runner detected');
  assert.equal(result.sessionConfigured, true, 'session detected');
  assert.deepEqual(
    result.readinessWarnings,
    [],
    'enforce + full env emits no readiness warnings',
  );
  // CRITICAL adversarial guard: env presence alone NEVER promotes authority.
  assert.equal(result.productionDone, false, 'env-complete enforce productionDone still false');
  assert.equal(result.receiptVerified, false, 'env-complete enforce receiptVerified still false');
  assert.equal(
    result.canClaimProductionDone,
    false,
    'env-complete enforce canClaimProductionDone still false',
  );
  assertNoProductionOverclaim(result, 'buildAuthorityStatus enforce-env-complete');
}

// Receipt-ref status facts are separate: verified / eligible / consumed are not
// collapsed into productionDone.
{
  const { root, store } = makeRoot();
  try {
    const storyId = 'B-status';
    seedStory(store, storyId);
    const ref = refFor(root, storyId);
    store.writeAuthorityReceiptRefs(storyId, upsertAuthorityGateReceiptRef(undefined, ref, NOW));
    const env: EnvOverride = {
      ...EMPTY_AUTHORITY_ENV,
      LATTICE_AUTHORITY_MODE: 'enforce',
      LATTICE_AUTHORITY_URL: 'https://authority.example',
      LATTICE_AUTHORITY_CUSTOMER_API_KEY: 'customer-key-canary',
      LATTICE_AUTHORITY_ACTOR_KEY: 'fake-key-blob',
      LATTICE_AUTHORITY_RUNNER_ID: 'runner-1',
    };
    const verified = buildAuthorityStatus({
      storyId,
      targetPhase: 'TEST',
      headHash: ref.headHash,
      materialHash: ref.materialHash,
      policyMode: 'balanced',
      now: NOW,
    }, env as Record<string, string | undefined>, { root, store });
    assert.equal(verified.authorityReady, true, 'enforce env complete marks authorityReady');
    assert.equal(verified.receiptVerified, true, 'production receipt ref is reported as verified');
    assert.equal(verified.receiptEligible, true, 'matching context is reported as eligible');
    assert.equal(verified.receiptConsumed, false, 'verified but unconsumed receipt stays unconsumed');
    assert.equal(verified.productionDone, false, 'verified receipt does not claim productionDone');
    assert.equal(verified.status, 'verified-receipt-eligible');

    const consumedRef: AuthorityGateDecisionReceiptRef = {
      ...ref,
      consumptionEvents: [{
        consumedAt: NOW,
        targetPhase: 'TEST',
        storyId,
        headHash: ref.headHash,
        materialHash: ref.materialHash,
        decisionDigest: ref.decisionDigest!,
      }],
    };
    store.writeAuthorityReceiptRefs(storyId, upsertAuthorityGateReceiptRef(undefined, consumedRef, NOW));
    const consumed = buildAuthorityStatus({
      storyId,
      targetPhase: 'TEST',
      headHash: ref.headHash,
      materialHash: ref.materialHash,
      policyMode: 'balanced',
      now: NOW,
    }, env as Record<string, string | undefined>, { root, store });
    assert.equal(consumed.receiptVerified, true, 'consumed receipt remains verified');
    assert.equal(consumed.receiptEligible, true, 'consumed receipt remains eligible');
    assert.equal(consumed.receiptConsumed, true, 'matching consumption event is reported separately');
    assert.equal(consumed.productionDone, false, 'consumed receipt still does not claim productionDone');
    assert.equal(consumed.status, 'receipt-consumed-no-production-claim');
    assertNoProductionOverclaim(consumed, 'buildAuthorityStatus consumed ref');

    const mixedStoryId = 'B-mixed';
    seedStory(store, mixedStoryId);
    const mixedEligibleRef: AuthorityGateDecisionReceiptRef = {
      ...refFor(root, mixedStoryId, { receiptId: 'AR-MIXED-TEST' }),
      consumptionEvents: [{
        consumedAt: NOW,
        targetPhase: 'TEST',
        storyId: mixedStoryId,
        headHash: ref.headHash,
        materialHash: ref.materialHash,
        decisionDigest: 'sha256:decision',
      }],
    };
    store.writeAuthorityReceiptRefs(mixedStoryId, upsertAuthorityGateReceiptRef(undefined, mixedEligibleRef, NOW));
    const newerNonmatchingRef = refFor(root, mixedStoryId, {
      receiptId: 'AR-MIXED-DONE',
      targetPhase: 'DONE',
      eligibleGates: ['DONE'],
      verifiedAt: '2026-06-10T00:01:00.000Z',
    });
    store.writeAuthorityReceiptRefs(
      mixedStoryId,
      upsertAuthorityGateReceiptRef(store.readAuthorityReceiptRefs(mixedStoryId) ?? undefined, newerNonmatchingRef, newerNonmatchingRef.verifiedAt!),
    );
    const mixed = buildAuthorityStatus({
      storyId: mixedStoryId,
      targetPhase: 'TEST',
      headHash: mixedEligibleRef.headHash,
      materialHash: mixedEligibleRef.materialHash,
      policyMode: 'balanced',
      now: NOW,
    }, env as Record<string, string | undefined>, { root, store });
    assert.equal(mixed.receiptVerified, true, 'multi-ref document reports verified from the eligible production ref');
    assert.equal(mixed.receiptEligible, true, 'multi-ref document reports eligibility from the eligible production ref');
    assert.equal(mixed.receiptConsumed, true, 'multi-ref document reports consumption from the eligible production ref');
    assert.equal(mixed.receiptStatus.latestReceiptId, 'AR-MIXED-DONE', 'raw latest ref remains visible');
    assert.equal(mixed.receiptStatus.statusReceiptId, 'AR-MIXED-TEST', 'status facts name the ref that backs current context');
    assert.equal(mixed.productionDone, false, 'multi-ref receipt status still cannot claim productionDone');
    assertNoProductionOverclaim(mixed, 'buildAuthorityStatus mixed refs');

    const diagnosticStoryId = 'B-local';
    seedStory(store, diagnosticStoryId);
    const localRef = refFor(root, diagnosticStoryId, {
      receiptId: 'AR-LOCAL',
      classification: 'server-receipt-local-test',
    });
    store.writeAuthorityReceiptRefs(diagnosticStoryId, upsertAuthorityGateReceiptRef(undefined, localRef, NOW));
    const diagnostic = buildAuthorityStatus({
      storyId: diagnosticStoryId,
      targetPhase: 'TEST',
      headHash: localRef.headHash,
      materialHash: localRef.materialHash,
      policyMode: 'balanced',
      now: NOW,
    }, env as Record<string, string | undefined>, { root, store });
    assert.equal(diagnostic.receiptVerified, false, 'local diagnostic receipt is not production verified');
    assert.equal(diagnostic.receiptEligible, false, 'local diagnostic receipt is not gate eligible');
    assert.equal(diagnostic.receiptConsumed, false, 'local diagnostic receipt is not consumed');
    assert.equal(diagnostic.productionDone, false, 'local diagnostic receipt cannot claim productionDone');
    assertNoProductionOverclaim(diagnostic, 'buildAuthorityStatus local diagnostic ref');

    const localMixedStoryId = 'B-mixed-local';
    seedStory(store, localMixedStoryId);
    const productionRef = refFor(root, localMixedStoryId, { receiptId: 'AR-PRODUCTION' });
    const newerLocalRef = refFor(root, localMixedStoryId, {
      receiptId: 'AR-LOCAL-LATER',
      classification: 'server-receipt-local-test',
      verifiedAt: '2026-06-10T00:01:00.000Z',
    });
    const mixedDocument = upsertAuthorityGateReceiptRef(
      upsertAuthorityGateReceiptRef(undefined, productionRef, NOW),
      newerLocalRef,
      '2026-06-10T00:01:00.000Z',
    );
    store.writeAuthorityReceiptRefs(localMixedStoryId, mixedDocument);
    const localMixed = buildAuthorityStatus({
      storyId: localMixedStoryId,
      targetPhase: 'TEST',
      headHash: productionRef.headHash,
      materialHash: productionRef.materialHash,
      policyMode: 'balanced',
      now: NOW,
    }, env as Record<string, string | undefined>, { root, store });
    assert.equal(localMixed.receiptVerified, true, 'newer local-test ref does not mask production verification');
    assert.equal(localMixed.receiptEligible, true, 'eligible production ref is used for gate status');
    assert.equal(localMixed.receiptConsumed, false, 'mixed verified ref is not consumed without event');
    assert.equal(localMixed.productionDone, false, 'mixed receipt status still does not claim productionDone');
    assert.equal(localMixed.receiptStatus.latestReceiptId, 'AR-LOCAL-LATER', 'latest diagnostic ref remains visible');
    assert.equal(localMixed.receiptStatus.statusReceiptId, 'AR-PRODUCTION', 'status uses verified production ref');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// Enforce can resolve URL/customer/actor/runner/session from authority.md.
{
  const env: EnvOverride = { ...EMPTY_AUTHORITY_ENV, LATTICE_AUTHORITY_MODE: 'enforce' };
  const result = buildAuthorityStatus({}, env as Record<string, string | undefined>, {
    cwd: '/proj',
    fileReader: p => (p.endsWith('.lattice/authority.md')
      ? [
        'serverUrl: https://authority-md.example',
        'customerApiKey: md-customer-key',
        'actorKey: md-actor-key',
        'runnerId: md-runner',
        'sessionId: md-session',
        'projectId: md-project',
      ].join('\n')
      : undefined),
  });
  assert.equal(result.authorityMdLoaded, true, 'authority.md is loaded in enforce mode');
  assert.equal(result.authorityUrlConfigured, true, 'authority.md serverUrl counts as configured');
  assert.equal(result.customerApiKeyConfigured, true, 'authority.md customer key counts as configured');
  assert.equal(result.customerApiKeySource, 'authority_md', 'authority.md customer key source is reported');
  assert.equal(result.actorKeyConfigured, true, 'authority.md actor key counts as configured');
  assert.equal(result.runnerConfigured, true, 'authority.md runnerId counts as configured');
  assert.equal(result.sessionConfigured, true, 'authority.md sessionId counts as configured');
  assert.deepEqual(result.readinessWarnings, [], 'authority.md-backed enforce config emits no missing-prerequisite warnings');
  assertNoProductionOverclaim(result, 'buildAuthorityStatus enforce-authority-md');
}

// Enforce can resolve URL/customer/server trust from root authority_trust.env.
{
  const env: EnvOverride = {
    ...EMPTY_AUTHORITY_ENV,
    LATTICE_AUTHORITY_MODE: 'enforce',
    LATTICE_AUTHORITY_TRUST_ENV_FILE: 'authority_trust.env',
  };
  const result = buildAuthorityStatus({}, env as Record<string, string | undefined>, {
    cwd: '/proj',
    fileReader: p => {
      if (p.endsWith('authority_trust.env')) {
        return [
          'LATTICE_AUTHORITY_LIVE_URL=https://authority-trust.example',
          'LATTICE_AUTHORITY_LIVE_PUBLIC_KEY=trust-public-key',
          'LATTICE_AUTHORITY_CUSTOMER_API_KEY_FILE=secrets/customer.key',
        ].join('\n');
      }
      if (p.endsWith('secrets/customer.key')) return 'trust-customer-key';
      return undefined;
    },
  });
  assert.equal(result.authorityTrustEnvLoaded, true, 'root authority_trust.env is loaded in enforce mode');
  assert.equal(result.urlSource, 'authority_trust_env', 'trust env URL source is reported');
  assert.equal(result.baseURLConfigured, true, 'trust env server URL counts as configured');
  assert.equal(result.customerApiKeyConfigured, true, 'trust env customer key path counts as configured');
  assert.equal(result.customerApiKeySource, 'authority_trust_env', 'trust env customer key source is reported');
  assert.equal(result.serverPublicKeyPinned, true, 'trust env public key counts as pinned');
  assert.equal(result.actorKeyConfigured, false, 'trust file without actor key does not imply actor readiness');
  assert.equal(result.runnerConfigured, false, 'trust file without runner id does not imply runner readiness');
  assert.equal(result.receiptVerified, false, 'trust env readiness is not receipt verification');
  assert.equal(result.productionDone, false, 'trust env readiness is not productionDone');
  assert.equal(result.canClaimProductionDone, false, 'trust env readiness cannot claim productionDone');
  assert.ok(!result.readinessWarnings.some(line => line.includes('CUSTOMER_API_KEY')), 'customer API key warning is cleared by trust env');
  assert.ok(result.readinessWarnings.some(line => line.includes('ACTOR_KEY')), 'actor key warning remains');
  assert.ok(result.readinessWarnings.some(line => line.includes('RUNNER_ID')), 'runner id warning remains');
  assertNoProductionOverclaim(result, 'buildAuthorityStatus enforce-authority-trust-env');
}

// Ordinary handoff fixture: Lattice-prefixed trust/client files remain consumable.
{
  const bundleRoot = mkdtempSync(join(tmpdir(), 'authority-handoff-target-'));
  try {
    const trustFileName = DEFAULT_AUTHORITY_TRUST_PROFILE_FILE_NAMES.trustFileName;
    const clientFileName = DEFAULT_AUTHORITY_TRUST_PROFILE_FILE_NAMES.clientFileName;
    const trustFilePath = join(bundleRoot, trustFileName);
    const clientFilePath = join(bundleRoot, clientFileName);
    writeFileSync(
      trustFilePath,
      [
        'LATTICE_AUTHORITY_MODE=enforce',
        'LATTICE_AUTHORITY_URL=https://authority.example/',
        'LATTICE_AUTHORITY_SERVER_PUBLIC_KEY=source-server-public-key',
        'LATTICE_AUTHORITY_SERVER_KEY_ID=source-server-key',
        'LATTICE_AUTHORITY_PROJECT_ID=source-project',
        `LATTICE_AUTHORITY_CUSTOMER_API_KEY_PATH=${clientFileName}`,
        '',
      ].join('\n'),
    );
    writeFileSync(clientFilePath, 'source-customer-key\n');

    const status = buildAuthorityStatus({}, {
      ...EMPTY_AUTHORITY_ENV,
      LATTICE_AUTHORITY_MODE: 'enforce',
      LATTICE_AUTHORITY_TRUST_ENV_FILE: trustFileName,
    }, { cwd: bundleRoot });
    assert.deepEqual(
      {
        authorityTrustEnvLoaded: status.authorityTrustEnvLoaded,
        authorityMdLoaded: status.authorityMdLoaded,
        authorityUrlConfigured: status.authorityUrlConfigured,
        customerApiKeyConfigured: status.customerApiKeyConfigured,
        customerApiKeySource: status.customerApiKeySource,
        resolvedBaseURL: status.resolvedBaseURL,
        actorKeyConfigured: status.actorKeyConfigured,
        runnerConfigured: status.runnerConfigured,
        serverPublicKeyPinned: status.serverPublicKeyPinned,
      },
      {
        authorityTrustEnvLoaded: true,
        authorityMdLoaded: false,
        authorityUrlConfigured: true,
        customerApiKeyConfigured: true,
        customerApiKeySource: 'authority_trust_env',
        resolvedBaseURL: 'https://authority.example/',
        actorKeyConfigured: false,
        runnerConfigured: false,
        serverPublicKeyPinned: true,
      },
    );
    assert.ok(!status.readinessWarnings.some(line => line.includes('CUSTOMER_API_KEY')));
    assert.ok(status.readinessWarnings.some(line => line.includes('ACTOR_KEY')));
    assert.ok(status.readinessWarnings.some(line => line.includes('RUNNER_ID')));
  } finally {
    rmSync(bundleRoot, { recursive: true, force: true });
  }
}

// CLI --root reads authority.md from the selected project root, not the shell cwd.
{
  const projectRoot = mkdtempSync(join(tmpdir(), 'lattice-authority-status-root-'));
  const outsideCwd = mkdtempSync(join(tmpdir(), 'lattice-authority-status-cwd-'));
  try {
    mkdirSync(join(projectRoot, '.lattice'), { recursive: true });
    writeFileSync(join(projectRoot, 'lattice.config.json'), JSON.stringify({
      scanRoot: '.',
      rootDir: '.',
      testsDir: 'tests',
      fixturesDir: 'tests/fixtures',
      storyDir: '.lattice/story/actives',
      requirementsDir: 'docs/requirements',
      storyPrefix: 'B',
    }, null, 2));
    writeFileSync(join(projectRoot, '.lattice', 'authority.md'), [
      'serverUrl: https://authority-root.example',
      'customerApiKey: root-customer-key',
      'actorKey: root-actor-key',
      'runnerId: root-runner',
      'sessionId: root-session',
      'projectId: root-project',
    ].join('\n'));

    const env: EnvOverride = { ...EMPTY_AUTHORITY_ENV, LATTICE_AUTHORITY_MODE: 'enforce' };
    const status = runJsonAtRoot<any>(projectRoot, ['authority_status', '--json'], env, outsideCwd);
    assert.equal(status.authorityMdLoaded, true, '--root authority_status loads target authority.md');
    assert.equal(status.baseURL, 'https://authority-root.example');
    assert.equal(status.resolvedBaseURL, 'https://authority-root.example');
    assert.equal(status.customerApiKeyConfigured, true);
    assert.equal(status.runnerConfigured, true);
    assert.equal(status.sessionConfigured, true);
    assert.deepEqual(status.readinessWarnings, [], '--root status uses authority.md prerequisites');

    const conduit = runJsonAtRoot<any>(projectRoot, ['conduit_status', '--json'], env, outsideCwd);
    assert.equal(conduit.mode, 'enforce', '--root conduit_status keeps enforce mode');
    assert.equal(conduit.authorityUrlConfigured, true, '--root conduit_status sees authority.md URL');
    assert.equal(conduit.runnerConfigured, true, '--root conduit_status sees authority.md runner');
    assert.deepEqual(conduit.readinessWarnings, [], '--root conduit_status uses authority.md prerequisites');

    const runner = runJsonAtRoot<any>(projectRoot, ['authority_enforce_runner', '--json', '--dryRun'], env, outsideCwd);
    assert.equal(runner.status, 'pass', '--root authority_enforce_runner dry-run uses authority.md prerequisites');
    assert.deepEqual(runner.readinessWarnings, []);
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
    rmSync(outsideCwd, { recursive: true, force: true });
  }
}

// conduit_status mirrors readiness without promoting authority.
{
  const env: EnvOverride = { ...EMPTY_AUTHORITY_ENV, LATTICE_AUTHORITY_MODE: 'shadow' };
  const result = buildConduitStatus(env as Record<string, string | undefined>);
  assert.equal(result.mode, 'shadow', 'conduit mode mirrors authority status');
  assert.equal(result.localWorkflowUsable, true, 'conduit localWorkflowUsable true');
  assert.equal(result.productionDone, false, 'conduit productionDone false');
  assert.equal(result.receiptVerified, false, 'conduit receiptVerified false');
  assert.equal(result.authorityChanged, false, 'conduit authorityChanged false');
  assert.ok(
    result.readinessWarnings.length > 0,
    'conduit surfaces shadow readiness warnings',
  );
  assertNoProductionOverclaim(result, 'buildConduitStatus shadow');
}

// conduit_status off mode mirrors the same zero trust-file / secret-file I/O boundary.
{
  const reads: string[] = [];
  const result = buildConduitStatus(
    {
      ...EMPTY_AUTHORITY_ENV,
      LATTICE_AUTHORITY_MODE: 'off',
      LATTICE_AUTHORITY_TRUST_ENV_FILE: 'authority_trust.env',
    } as Record<string, string | undefined>,
    {
      cwd: '/proj',
      fileReader: p => {
        reads.push(p);
        if (p.endsWith('authority_trust.env')) {
          return 'LATTICE_AUTHORITY_CUSTOMER_API_KEY_FILE=secrets/customer.key';
        }
        if (p.endsWith('secrets/customer.key')) return 'secret-key';
        return undefined;
      },
    },
  );
  assert.deepEqual(reads, [], 'conduit off mode does not read authority_trust.env or referenced secret files');
  assert.equal(result.mode, 'off', 'conduit off-mode remains off');
  assert.equal(result.productionDone, false, 'conduit off-mode productionDone false');
  assert.equal(result.receiptVerified, false, 'conduit off-mode receiptVerified false');
  assertNoProductionOverclaim(result, 'buildConduitStatus off-mode-zero-trust-io');
}

// ── CLI integration: text + JSON (--format=json AND --json shortcut) ───────

// off mode through CLI (text output)
{
  const text = runText(['authority_status'], EMPTY_AUTHORITY_ENV);
  assert.match(text, /mode: off/, 'CLI text shows mode: off');
  assert.match(text, /localWorkflowUsable: true/, 'CLI text shows localWorkflowUsable: true');
  assert.match(text, /productionDone: false/, 'CLI text shows productionDone: false');
  assert.doesNotMatch(text, /readinessWarnings:\n  - /, 'off-mode CLI text does not emit readiness warnings list');
}

// off mode through CLI with --json shortcut
{
  const json = runJson<any>(['authority_status', '--json'], EMPTY_AUTHORITY_ENV);
  assert.equal(json.mode, 'off', '--json reports mode off');
  assert.equal(json.localWorkflowUsable, true, '--json reports localWorkflowUsable true');
  assert.equal(json.productionDone, false, '--json reports productionDone false');
  assert.equal(json.receiptVerified, false, '--json reports receiptVerified false');
  assert.equal(json.canClaimProductionDone, false, '--json reports canClaimProductionDone false');
  assert.deepEqual(json.readinessWarnings, [], '--json off-mode no readiness warnings');
  assertNoProductionOverclaim(json, 'CLI authority_status --json off');
}

// off mode through CLI with --format=json (legacy form)
{
  const json = runJson<any>(['authority_status', '--format=json'], EMPTY_AUTHORITY_ENV);
  assert.equal(json.mode, 'off', '--format=json reports mode off');
  assert.equal(json.localWorkflowUsable, true, '--format=json reports localWorkflowUsable true');
  assertNoProductionOverclaim(json, 'CLI authority_status --format=json off');
}

// shadow + missing URL through CLI
{
  const json = runJson<any>(['authority_status', '--json'], {
    ...EMPTY_AUTHORITY_ENV,
    LATTICE_AUTHORITY_MODE: 'shadow',
  });
  assert.equal(json.mode, 'shadow', 'shadow CLI JSON mode shadow');
  assert.equal(json.localWorkflowUsable, true, 'shadow CLI JSON localWorkflowUsable true');
  assert.ok(
    Array.isArray(json.readinessWarnings) && json.readinessWarnings.length >= 1,
    'shadow CLI JSON readinessWarnings non-empty',
  );
  assert.equal(json.productionDone, false, 'shadow CLI JSON productionDone false');
  assertNoProductionOverclaim(json, 'CLI authority_status --json shadow');
}

// enforce + localhost default + missing prereqs through CLI: warnings + still safe.
{
  const json = runJson<any>(['authority_status', '--json'], {
    ...EMPTY_AUTHORITY_ENV,
    LATTICE_AUTHORITY_MODE: 'enforce',
  });
  assert.equal(json.mode, 'enforce', 'enforce CLI JSON mode enforce');
  assert.ok(
    json.readinessWarnings.length >= 3,
    `enforce CLI JSON readinessWarnings includes customer/actor/runner; got ${json.readinessWarnings.length}`,
  );
  assert.ok(
    json.nextActions.some((a: string) => /LATTICE_AUTHORITY_CUSTOMER_API_KEY/.test(a)),
    'enforce CLI JSON suggests customer key next action',
  );
  assert.equal(json.productionDone, false, 'enforce CLI JSON productionDone still false');
  assert.equal(json.canClaimProductionDone, false, 'enforce CLI JSON canClaimProductionDone false');
  assertNoProductionOverclaim(json, 'CLI authority_status --json enforce');
}

// enforce + all env set through CLI: still NOT productionDone.
{
  const json = runJson<any>(['authority_status', '--json'], {
    ...EMPTY_AUTHORITY_ENV,
    LATTICE_AUTHORITY_MODE: 'enforce',
    LATTICE_AUTHORITY_URL: 'https://authority.example',
    LATTICE_AUTHORITY_CUSTOMER_API_KEY: 'customer-key-canary',
    LATTICE_AUTHORITY_ACTOR_KEY_PATH: '/tmp/fake-key.pem',
    LATTICE_AUTHORITY_RUNNER_ID: 'runner-x',
  });
  assert.equal(json.authorityUrlConfigured, true);
  assert.equal(json.actorKeyConfigured, true);
  assert.equal(json.runnerConfigured, true);
  assert.deepEqual(json.readinessWarnings, [], 'env-complete enforce CLI JSON no warnings');
  assert.equal(json.productionDone, false, 'env-complete enforce CLI JSON productionDone still false');
  assert.equal(json.receiptVerified, false, 'env-complete enforce CLI JSON receiptVerified still false');
  assert.equal(
    json.canClaimProductionDone,
    false,
    'env-complete enforce CLI JSON canClaimProductionDone still false',
  );
  assertNoProductionOverclaim(json, 'CLI authority_status --json enforce env-complete');
}

// conduit_status through CLI mirrors readiness
{
  const json = runJson<any>(['conduit_status', '--json'], {
    ...EMPTY_AUTHORITY_ENV,
    LATTICE_AUTHORITY_MODE: 'enforce',
  });
  assert.equal(json.mode, 'enforce', 'conduit CLI JSON mode enforce');
  assert.equal(json.localWorkflowUsable, true, 'conduit CLI JSON localWorkflowUsable true');
  assert.ok(
    json.readinessWarnings.length >= 1,
    'conduit CLI JSON readinessWarnings non-empty',
  );
  assert.equal(json.productionDone, false, 'conduit CLI JSON productionDone false');
  assert.equal(json.receiptVerified, false, 'conduit CLI JSON receiptVerified false');
  assert.equal(json.authorityChanged, false, 'conduit CLI JSON authorityChanged false');
  assertNoProductionOverclaim(json, 'CLI conduit_status --json enforce');
}

// conduit explain still includes the no-runner / no-receipt statement.
{
  const json = runJson<any>(['conduit_explain', '--json'], EMPTY_AUTHORITY_ENV);
  assert.equal(json.localWorkflowUsable, true);
  assert.equal(json.productionDone, false);
  assert.ok(
    json.explanation.some((line: string) => /off = default local-only/i.test(line)),
    'conduit explain documents off mode as default local-only workflow',
  );
  assert.ok(
    json.explanation.some((line: string) => /enforce.*Lattice Authority server.*actor key.*runner/i.test(line)),
    'conduit explain documents enforce mode prerequisites',
  );
  assertNoProductionOverclaim(json, 'CLI conduit_explain --json');
}

console.log('✓ authority status readiness smoke passed');
