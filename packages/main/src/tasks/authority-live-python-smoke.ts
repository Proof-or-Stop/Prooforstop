#!/usr/bin/env node
//
// authority-live-python-smoke (B-2522 CHK-002)
//
// Live integration smoke proving the CLI can drive a real Python Lattice
// Authority server BEYOND read-only policy discovery — i.e. the runner control
// plane (register actor key + runner, heartbeat, claim, release) and, when a
// claimed job carrying typed plannedSteps[] is available, one bounded authority
// job execution with gate-receipt verification.
//
// Required live env (otherwise this skips with an explicit reason, exit 0):
//   LATTICE_AUTHORITY_LIVE_URL         — e.g. http://127.0.0.1:8080 (or LATTICE_AUTHORITY_URL)
//   LATTICE_AUTHORITY_LIVE_PUBLIC_KEY  — hex or base64 Ed25519 server public key
//
// Optional live control-plane env (claim + lease heartbeat/release):
//   LATTICE_AUTHORITY_ACTOR_KEY | LATTICE_AUTHORITY_ACTOR_KEY_PATH
//   LATTICE_AUTHORITY_RUNNER_ID
//   LATTICE_AUTHORITY_PROJECT_ID
//   (optional) LATTICE_AUTHORITY_SESSION_ID / ACTOR_ID / ACTOR_ROLE /
//              ACTOR_KEY_ID / ACTOR_KEY_ENCODING / BOOTSTRAP_TOKEN
//
// Optional CLI-loop job execution env (full authority job beyond control plane):
//   LATTICE_AUTHORITY_LIVE_JOB_FILE     — JSON file of a claimed authority job
//                                         envelope ({jobId,storyId,mode,until,plannedSteps})
//   LATTICE_AUTHORITY_LIVE_RECEIPT_FILE — JSON file of a native gate_decision receipt
//
// This file deliberately performs NO deterministic assertions of its own when
// the live env is absent — it skips. The deterministic, stub-server exercise of
// the SAME driver lives in authority-live-python-stub-smoke.ts so a missing
// server can never be mistaken for a green run against a real one.

import assert from 'node:assert/strict';
import { readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AuthorityClient, type AuthorityFetch } from '../core/authority-client.js';
import {
  consumeClaimedAuthorityJob,
  parseClaimedAuthorityJob,
  readActorPrivateKeyFromPath,
  runLatticeAuthorityControlPlaneOnce,
  type AuthorityRunnerNetworkEvent,
  type ClaimedAuthorityJobDisposition,
  type LatticeAuthorityLiveRunnerOptions,
} from '../core/authority-runner.js';
import {
  verifyLatticeAuthorityReceipt,
  type LatticeAuthorityKeyEncoding,
} from '../core/lattice-authority-native.js';
import type { PlannerStoreLike } from '../core/planner.js';
import type { StoryInfo } from '../core/types.js';

// ───────────────────────────────────────────────────────────────────────────
// Shared driver — exercised live (real fetch/env) by this file's entrypoint and
// deterministically (injected stub fetch) by authority-live-python-stub-smoke.
// ───────────────────────────────────────────────────────────────────────────

export interface LivePythonSmokeOptions {
  env: Record<string, string | undefined>;
  /** node-fetch-shaped impl for the runner control plane; defaults to global fetch. */
  controlPlaneFetch?: typeof fetch;
  /** AuthorityClient-shaped impl for policy discovery; defaults to global fetch. */
  clientFetch?: AuthorityFetch;
  /** Store used when consuming a claimed job's plannedSteps[]. */
  store?: PlannerStoreLike;
  /** Root dir for plannedSteps execution (defaults to an os tmp path). */
  jobRoot?: string;
  /** Claimed-job envelope override (bypasses LATTICE_AUTHORITY_LIVE_JOB_FILE). */
  job?: unknown;
  /** Native gate_decision receipt override (bypasses LATTICE_AUTHORITY_LIVE_RECEIPT_FILE). */
  receipt?: unknown;
  now?: () => Date;
  log?: (line: string) => void;
}

export interface LivePythonControlPlaneSummary {
  ran: boolean;
  status: 'pass' | 'fail';
  networkEvents: AuthorityRunnerNetworkEvent[];
  claimedJobId: string | null;
  releasedJobId: string | null;
  note?: string;
}

export interface LivePythonJobSummary {
  ran: boolean;
  jobId: string;
  receiptRequired: boolean;
  receiptProvided: boolean;
  receiptSignatureVerified: boolean;
  receiptVerified: boolean;
  authorityDone: boolean;
  disposition: ClaimedAuthorityJobDisposition;
  releaseReason: string;
  executionStatus: string | null;
}

export interface LivePythonSmokeResult {
  skipped: boolean;
  skipReason?: string;
  url?: string;
  policy?: {
    serverKeyVerified: boolean;
    expectedServerKeyHex: string;
    actualServerKeyHex: string;
  };
  controlPlane?: LivePythonControlPlaneSummary;
  job?: LivePythonJobSummary;
}

function envValue(env: Record<string, string | undefined>, suffix: string): string | undefined {
  const canonical = env[`LATTICE_AUTHORITY_${suffix}`];
  if (typeof canonical === 'string' && canonical.trim().length > 0) return canonical.trim();
  const legacy = env[`LATTICE_AUTHORITY_${suffix}`];
  if (typeof legacy === 'string' && legacy.trim().length > 0) return legacy.trim();
  return undefined;
}

function normalizeKeyToHex(value: string): string {
  return /^[0-9a-fA-F]{64}$/.test(value)
    ? value.toLowerCase()
    : Buffer.from(value, 'base64').toString('hex');
}

function resolveActorPrivateKey(env: Record<string, string | undefined>): string | undefined {
  const inline = envValue(env, 'ACTOR_KEY');
  if (inline) return inline;
  const path = envValue(env, 'ACTOR_KEY_PATH');
  return path ? readActorPrivateKeyFromPath(path) : undefined;
}

function resolveCustomerApiKey(env: Record<string, string | undefined>): string | undefined {
  const inline = envValue(env, 'CUSTOMER_API_KEY');
  if (inline) return inline;
  const path = envValue(env, 'CUSTOMER_API_KEY_PATH');
  return path ? readActorPrivateKeyFromPath(path) : undefined;
}

function hasControlPlaneEnv(env: Record<string, string | undefined>): boolean {
  return Boolean(
    (envValue(env, 'ACTOR_KEY') || envValue(env, 'ACTOR_KEY_PATH')) &&
      envValue(env, 'RUNNER_ID') &&
      envValue(env, 'PROJECT_ID'),
  );
}

function buildLiveRunnerOptions(
  env: Record<string, string | undefined>,
  baseURL: string,
  fetchImpl?: typeof fetch,
): LatticeAuthorityLiveRunnerOptions {
  const actorPrivateKey = resolveActorPrivateKey(env);
  if (!actorPrivateKey) throw new Error('control-plane requires LATTICE_AUTHORITY_ACTOR_KEY or LATTICE_AUTHORITY_ACTOR_KEY_PATH');
  const runnerId = envValue(env, 'RUNNER_ID');
  if (!runnerId) throw new Error('control-plane requires LATTICE_AUTHORITY_RUNNER_ID');
  const projectId = envValue(env, 'PROJECT_ID');
  if (!projectId) throw new Error('control-plane requires LATTICE_AUTHORITY_PROJECT_ID');
  const timeoutRaw = Number(envValue(env, 'TIMEOUT_MS'));
  const customerApiKey = resolveCustomerApiKey(env);
  return {
    baseURL,
    timeoutMS: Number.isFinite(timeoutRaw) && timeoutRaw > 0 ? timeoutRaw : 10_000,
    actorId: envValue(env, 'ACTOR_ID') ?? runnerId,
    role: envValue(env, 'ACTOR_ROLE') ?? 'runner',
    actorKeyId: envValue(env, 'ACTOR_KEY_ID') ?? 'default',
    actorPrivateKey,
    actorPrivateKeyEncoding: (envValue(env, 'ACTOR_KEY_ENCODING') ?? 'auto') as LatticeAuthorityKeyEncoding,
    runnerId,
    sessionId: envValue(env, 'SESSION_ID') ?? `${runnerId}:session`,
    projectId,
    ...(customerApiKey ? { customerApiKey } : {}),
    bootstrapToken: envValue(env, 'BOOTSTRAP_TOKEN'),
    once: true,
    ...(fetchImpl ? { fetchImpl } : {}),
  };
}

function readJsonOverride(value: unknown, file: string | undefined): unknown {
  if (value !== undefined) return value;
  if (!file) return undefined;
  return JSON.parse(readFileSync(file, 'utf8'));
}

function inMemoryStore(storyId: string): PlannerStoreLike {
  const story = { storyId, phase: 'DEV' } as StoryInfo;
  return {
    readStory: () => story,
    storyExists: (id: string) => id === storyId,
    listStoryIds: () => [storyId],
    appendProcessEvent: () => {},
  };
}

/**
 * Drive the live-python authority smoke: policy discovery → control-plane
 * (register/heartbeat/claim/release) → optional claimed-job plannedSteps
 * execution with gate-receipt verification. Pure with respect to its injected
 * fetch impls and store, so the exact same path runs against a real server
 * (entrypoint below) and a stub server (stub smoke).
 */
export async function runLivePythonAuthoritySmoke(
  options: LivePythonSmokeOptions,
): Promise<LivePythonSmokeResult> {
  const { env } = options;
  const log = options.log ?? (() => {});
  const liveURL = envValue(env, 'LIVE_URL') ?? envValue(env, 'URL');
  const livePublicKey = envValue(env, 'LIVE_PUBLIC_KEY');
  if (!liveURL || !livePublicKey) {
    return {
      skipped: true,
      skipReason:
        'set LATTICE_AUTHORITY_LIVE_URL and LATTICE_AUTHORITY_LIVE_PUBLIC_KEY to run the live Python authority smoke',
    };
  }

  const result: LivePythonSmokeResult = { skipped: false, url: liveURL };

  // 1. Policy discovery — read-only, but verify the advertised server key.
  const client = new AuthorityClient(liveURL, options.clientFetch);
  const outcome = await client.discoverPolicy();
  if (!outcome.ok) {
    throw new Error(
      `discoverPolicy failed (kind=${'kind' in outcome ? outcome.kind : 'unknown'}${'status' in outcome ? ` status=${outcome.status}` : ''})`,
    );
  }
  const policy = outcome.data!;
  assert(policy.serverKey, 'policy must expose serverKey');
  assert.equal(policy.serverKey!.algorithm, 'ed25519');
  const expectedServerKeyHex = normalizeKeyToHex(livePublicKey);
  const actualServerKeyHex = policy.serverKey!.publicKeyHex.toLowerCase();
  assert.equal(actualServerKeyHex, expectedServerKeyHex, 'advertised serverKey must match LATTICE_AUTHORITY_LIVE_PUBLIC_KEY');
  result.policy = { serverKeyVerified: true, expectedServerKeyHex, actualServerKeyHex };
  log(`policy discovery ok: serverKey verified (url=${liveURL})`);

  // 2. Control plane — register, heartbeat, claim, release (beyond discovery).
  if (hasControlPlaneEnv(env)) {
    const runnerOptions = buildLiveRunnerOptions(env, liveURL, options.controlPlaneFetch);
    const live = await runLatticeAuthorityControlPlaneOnce(runnerOptions);
    result.controlPlane = {
      ran: true,
      status: live.status,
      networkEvents: live.networkEvents ?? [],
      claimedJobId: live.claimedJobId ?? null,
      releasedJobId: live.releasedJobId ?? null,
      note: live.note,
    };
    log(
      `control-plane ${live.status}: ${(live.networkEvents ?? []).map(e => `${e.step}=${e.ok ? 'ok' : 'fail'}`).join(' ')}`,
    );
  } else {
    result.controlPlane = { ran: false, status: 'pass', networkEvents: [], claimedJobId: null, releasedJobId: null };
  }

  // 3. Claimed-job plannedSteps execution + gate-receipt verification (optional).
  const rawJob = readJsonOverride(options.job, envValue(env, 'LIVE_JOB_FILE'));
  if (rawJob !== undefined) {
    const parsed = parseClaimedAuthorityJob(rawJob);
    if (!parsed.ok) throw new Error(`claimed job envelope invalid: ${parsed.reason}`);
    const job = parsed.job;

    const rawReceipt = readJsonOverride(options.receipt, envValue(env, 'LIVE_RECEIPT_FILE'));
    let receiptSignatureVerified = false;
    const receiptProvided = rawReceipt !== undefined;
    if (receiptProvided) {
      const verification = verifyLatticeAuthorityReceipt(rawReceipt, {
        serverPublicKey: expectedServerKeyHex,
        serverPublicKeyEncoding: 'hex',
        expectedKind: 'gate_decision',
        expectedStoryId: job.storyId,
        ...(options.now ? { now: options.now() } : {}),
      });
      receiptSignatureVerified = verification.verified;
      log(`gate receipt verification: verified=${verification.verified} (${verification.reason})`);
    }

    const store = options.store ?? inMemoryStore(job.storyId);
    const consumed = consumeClaimedAuthorityJob({
      root: options.jobRoot ?? join(tmpdir(), 'lattice-live-python-job'),
      store,
      job,
      receiptVerified: receiptSignatureVerified,
      ...(options.now ? { now: options.now } : {}),
    });
    result.job = {
      ran: true,
      jobId: consumed.jobId,
      receiptRequired: consumed.receiptRequired,
      receiptProvided,
      receiptSignatureVerified,
      receiptVerified: consumed.receiptVerified,
      authorityDone: consumed.authorityDone,
      disposition: consumed.disposition,
      releaseReason: consumed.releaseReason,
      executionStatus: consumed.execution?.status ?? null,
    };
    log(`claimed-job consumed: disposition=${consumed.disposition} authorityDone=${consumed.authorityDone} reason=${consumed.releaseReason}`);
  }

  return result;
}

// ───────────────────────────────────────────────────────────────────────────
// Shared assertion contract — reused by the stub smoke so the live and
// deterministic paths agree on what "beyond policy discovery" must prove.
// ───────────────────────────────────────────────────────────────────────────

function eventFor(
  events: AuthorityRunnerNetworkEvent[],
  step: AuthorityRunnerNetworkEvent['step'],
): AuthorityRunnerNetworkEvent | undefined {
  return events.find(e => e.step === step);
}

/**
 * Assert the control-plane proved real endpoint connectivity for claim + lease
 * heartbeat/release at minimum. A claimed job (claimedJobId set) additionally
 * requires a successful release so leases are never left dangling.
 */
export function assertControlPlaneContract(result: LivePythonSmokeResult): void {
  const cp = result.controlPlane;
  assert(cp && cp.ran, 'control-plane must have run (set actor key + runner id + project id)');
  assert.equal(cp.status, 'pass', `control-plane status must be pass: ${JSON.stringify(cp.networkEvents)}`);

  const heartbeat = eventFor(cp.networkEvents, 'runner_heartbeat');
  assert(heartbeat && heartbeat.ok, 'runner_heartbeat endpoint must respond ok');
  const claim = eventFor(cp.networkEvents, 'claim_job');
  assert(claim && claim.ok, 'claim_job endpoint must respond ok');

  if (cp.claimedJobId) {
    const release = eventFor(cp.networkEvents, 'release_job');
    assert(release && release.ok, 'a claimed job must be released (no dangling lease)');
    assert.equal(cp.releasedJobId, cp.claimedJobId, 'releasedJobId must match the claimed job');
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Live entrypoint — real env, real fetch. Skips explicitly when env is absent.
// ───────────────────────────────────────────────────────────────────────────

function isRunAsMain(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isRunAsMain()) {
  const result = await runLivePythonAuthoritySmoke({ env: process.env, log: line => console.log(`  ${line}`) });
  if (result.skipped) {
    console.log(`authority live Python smoke SKIPPED: ${result.skipReason}`);
    process.exit(0);
  }
  assert(result.policy?.serverKeyVerified, 'live policy serverKey must be verified');
  if (result.controlPlane?.ran) {
    assertControlPlaneContract(result);
    const job = result.job?.ran
      ? `; job disposition=${result.job.disposition} authorityDone=${result.job.authorityDone}`
      : '';
    console.log(
      `authority live Python smoke passed: policy + control-plane (claim/heartbeat/release) url=${result.url} claimedJobId=${result.controlPlane.claimedJobId ?? 'none'}${job}`,
    );
  } else {
    console.log(
      `authority live Python smoke passed: discoverPolicy serverKey verified url=${result.url} (control-plane env not set; claim/heartbeat/release skipped — set LATTICE_AUTHORITY_ACTOR_KEY + RUNNER_ID + PROJECT_ID to exercise it)`,
    );
  }
  process.exit(0);
}
