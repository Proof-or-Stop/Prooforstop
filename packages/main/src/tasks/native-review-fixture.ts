import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { closeSync, openSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { generateEd25519KeyPair } from '../core/authority-signing.js';
import {
  signNativeReviewInvocationAttestation,
  type NativeReviewBrokerRegistration,
} from '../core/native-review-attestation.js';
import { resetSessionIdForTest } from '../core/owner-session.js';
import { getSessionIdentity } from '../core/owner-session.js';
import {
  issueNativeReviewEvidenceBinding,
  observeNativeHostProcess,
  type NativeHostProcessObservation,
} from '../core/native-review-evidence.js';
import { verifyCurrentReviewerDispatchBinding } from '../core/review-run.js';
import {
  DELIVERY_REVIEW_LANE,
  verifyCurrentDeliveryReviewDispatch,
} from '../core/delivery-review-authority.js';
import type { StoryStore } from '../core/store.js';
import { sanitizedFixtureChildEnvironment } from './fixture-environment.js';

const keys = generateEd25519KeyPair();
const CLI = fileURLToPath(new URL('../cli.js', import.meta.url));

export function nativeReviewFixtureBrokers(): NativeReviewBrokerRegistration[] {
  return [
    { brokerId: 'fixture-codex-broker', adapterId: 'codex-fixture-adapter', host: 'codex', publicKey: keys.publicKey },
    { brokerId: 'fixture-claude-broker', adapterId: 'claude-fixture-adapter', host: 'claude', publicKey: keys.publicKey },
  ];
}

/**
 * Resolve the host a fixture identity may legitimately claim.
 *
 * `issueNativeReviewEvidenceBinding` vetoes any binding whose declared host
 * disagrees with the observed Codex/Claude process ancestry — that veto is real
 * product behaviour and these smokes must not weaken or bypass it. A fixture
 * that hard-coded one host therefore only passed under that host and failed
 * under the other, purely because of who ran `lattice validate`.
 *
 * So the fixture declares the host it is ACTUALLY running under whenever the
 * ancestry is observable, and falls back to `codex` only when no provider
 * ancestry is visible (no process table, or a non-provider parent) — the case
 * where the veto's ancestry check cannot fire anyway. Mixed ancestry is left
 * alone: that is an unconditional cross-provider veto the smokes should keep
 * observing.
 */
export function nativeReviewFixtureAmbientHost(
  observe: () => NativeHostProcessObservation | null = observeNativeHostProcess,
): 'codex' | 'claude' {
  return resolveNativeReviewFixtureAmbientHost(observe).host;
}

/**
 * Same resolution as {@link nativeReviewFixtureAmbientHost}, but also reports
 * whether a single provider ancestry was genuinely OBSERVED.
 *
 * The distinction matters for negative controls. `host` is `'codex'` both when
 * ancestry really is Codex and when ancestry is unobservable (no process table,
 * a non-provider parent, or mixed families) — but the ancestry veto can only
 * fire in the first case. A test that asserts "the non-ambient host must be
 * vetoed" is therefore only valid when `observed` is true; otherwise NEITHER
 * host trips the veto and the declared host is accepted as-is.
 */
export function resolveNativeReviewFixtureAmbientHost(
  observe: () => NativeHostProcessObservation | null = observeNativeHostProcess,
): { host: 'codex' | 'claude'; observed: boolean } {
  let seen: NativeHostProcessObservation | null = null;
  try {
    seen = observe();
  } catch {
    return { host: 'codex', observed: false };
  }
  // Mixed families are an unconditional veto for EVERY declared host, so they
  // are not a usable "ambient host" either.
  if (!seen || seen.mixedProviderFamilies) return { host: 'codex', observed: false };
  return { host: seen.host === 'claude' ? 'claude' : 'codex', observed: true };
}

/**
 * Native-review smokes must not inherit authority from whichever host happens
 * to execute the validation command.  This fixture identity is deliberately
 * explicit and is only the host-side precursor used to create a signed
 * dispatch; the one-shot broker attestation below remains required for formal
 * evidence closeout. Only the host LABEL follows the ambient ancestry (see
 * {@link nativeReviewFixtureAmbientHost}); no authority is inherited.
 */
export function nativeReviewFixtureHostEnvironment(
  agent: string,
  host: 'codex' | 'claude' = nativeReviewFixtureAmbientHost(),
  sessionId = `native-review-fixture-host-${randomUUID()}`,
): Record<string, string> {
  return {
    PROOF_OR_STOP_SESSION_ID: sessionId,
    PROOF_OR_STOP_AGENT: agent,
    PROOF_OR_STOP_OWNER_SESSION_ADAPTER_PROVIDER: host === 'claude' ? 'claude-code' : 'codex',
    PROOF_OR_STOP_OWNER_SESSION_ADAPTER_TASK: `native-review-fixture:${agent}`,
    PROOF_OR_STOP_OWNER_SESSION_ADAPTER_AGENT: agent,
    ...(host === 'claude' ? { CLAUDE_CODE_SESSION_ID: sessionId } : {}),
  };
}

export function withNativeReviewFixtureHostIdentity<T>(args: {
  agent: string;
  host?: 'codex' | 'claude';
  invoke: () => T;
}): T {
  const environment = nativeReviewFixtureHostEnvironment(args.agent, args.host);
  const envKeys = Object.keys(environment);
  const previous = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
  try {
    Object.assign(process.env, environment);
    resetSessionIdForTest();
    return args.invoke();
  } finally {
    resetSessionIdForTest();
    for (const key of envKeys) {
      const value = previous[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function fixtureInvocation(args: {
  root: string;
  store: StoryStore;
  storyId: string;
  agent: string;
  reviewRunId: string;
}) {
  const story = args.store.readStory(args.storyId);
  if (!story?.currentReviewRound) throw new Error('native review fixture requires an active review round');
  const run = args.store.readReviewRuns(args.storyId).runs.find(row => row.reviewRunId === args.reviewRunId);
  const dispatch = verifyCurrentReviewerDispatchBinding({
    store: args.store,
    storyId: args.storyId,
    lane: args.agent,
    reviewRound: story.currentReviewRound,
    projectRoot: args.root,
    reviewPurpose: run?.reviewPurpose, inventoryBinding: run?.inventoryBinding,
  });
  if (!dispatch.ok) throw new Error(`native review fixture has no signed dispatch binding: ${dispatch.reason}`);
  const broker = nativeReviewFixtureBrokers().find(candidate => candidate.host === dispatch.binding.hostRenderHost);
  if (!broker) throw new Error(`native review fixture has no broker for ${dispatch.binding.hostRenderHost}`);
  const writerSessionId = `native-review-fixture-${randomUUID()}`;
  const now = Date.now();
  const attestation = signNativeReviewInvocationAttestation({
    schemaVersion: 'lattice.native_review_invocation_attestation.v1',
    brokerId: broker.brokerId,
    adapterId: broker.adapterId,
    host: broker.host,
    storyId: args.storyId,
    agent: args.agent,
    lane: args.agent,
    reviewRunId: args.reviewRunId,
    writerSessionId,
    dispatchPromptDigest: dispatch.binding.dispatchPromptDigest,
    dispatchBindingDigest: dispatch.binding.dispatchBindingDigest,
    hostRenderIdentityDigest: dispatch.binding.hostRenderIdentityDigest,
    invocationNonce: randomUUID(),
    issuedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 60_000).toISOString(),
  }, keys.privateKey);
  return {
    attestation,
    env: nativeReviewFixtureHostEnvironment(args.agent, broker.host, writerSessionId),
  };
}

export async function runBrokeredNativeReviewCli(args: {
  root: string;
  store: StoryStore;
  storyId: string;
  agent: string;
  reviewRunId: string;
  command: 'review_pass_set' | 'finding_add';
  payload: Record<string, unknown>;
}): Promise<string> {
  const invocation = fixtureInvocation(args);
  return new Promise<string>((resolvePromise, reject) => {
    const child = spawn(process.execPath, [CLI, args.command, JSON.stringify(args.payload)], {
      cwd: args.root,
      env: {
        ...sanitizedFixtureChildEnvironment(process.env),
        ...invocation.env,
        LATTICE_NATIVE_REVIEW_ATTESTATION_FD: '3',
      },
      stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout!.setEncoding('utf8');
    child.stderr!.setEncoding('utf8');
    child.stdout!.on('data', chunk => { stdout += String(chunk); });
    child.stderr!.on('data', chunk => { stderr += String(chunk); });
    child.once('error', reject);
    child.once('exit', code => {
      if (code === 0) resolvePromise(stdout);
      else reject(new Error(`${args.command} exited ${code}: ${stderr}`));
    });
    const brokerPipe = child.stdio[3] as NodeJS.WritableStream;
    brokerPipe.write(`${JSON.stringify(invocation.attestation)}\n`);
    brokerPipe.end();
  });
}

/**
 * Execute one direct handler closeout under the same signed, one-shot
 * descriptor boundary used by an integrated Codex/Claude host adapter. The
 * fixture owns the broker private key; ordinary production CLI exposes no
 * issuer and receives only the inherited descriptor.
 */
export function withBrokeredNativeReviewInvocation<T>(args: {
  root: string;
  store: StoryStore;
  storyId: string;
  agent: string;
  reviewRunId: string;
  invoke: () => T;
}): T {
  const invocation = fixtureInvocation(args);
  const path = join(args.root, `.native-review-fixture-${randomUUID()}.json`);
  writeFileSync(path, `${JSON.stringify(invocation.attestation)}\n`, { mode: 0o600 });
  const fd = openSync(path, 'r');
  const envKeys = [
    'LATTICE_NATIVE_REVIEW_ATTESTATION_FD',
    'PROOF_OR_STOP_SESSION_ID',
    'PROOF_OR_STOP_AGENT',
    'PROOF_OR_STOP_OWNER_SESSION_ADAPTER_PROVIDER',
    'PROOF_OR_STOP_OWNER_SESSION_ADAPTER_TASK',
    'PROOF_OR_STOP_OWNER_SESSION_ADAPTER_AGENT',
    'CLAUDE_CODE_SESSION_ID',
  ] as const;
  const previous = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
  try {
    process.env.LATTICE_NATIVE_REVIEW_ATTESTATION_FD = String(fd);
    Object.assign(process.env, invocation.env);
    resetSessionIdForTest();
    return args.invoke();
  } finally {
    resetSessionIdForTest();
    for (const key of envKeys) {
      const value = previous[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    closeSync(fd);
    unlinkSync(path);
  }
}

export function issueBrokeredNativeReviewBinding(args: {
  root: string;
  store: StoryStore;
  storyId: string;
  agent: string;
  reviewRunId: string;
}) {
  const story = args.store.readStory(args.storyId);
  if (!story?.currentReviewRound) throw new Error('native review fixture requires an active review round');
  const dispatch = verifyCurrentReviewerDispatchBinding({
    store: args.store,
    storyId: args.storyId,
    lane: args.agent,
    reviewRound: story.currentReviewRound,
    projectRoot: args.root,
  });
  if (!dispatch.ok) throw new Error(`native review fixture has no signed dispatch binding: ${dispatch.reason}`);
  return withBrokeredNativeReviewInvocation({
    ...args,
    invoke: () => issueNativeReviewEvidenceBinding({
      projectRoot: args.root,
      storyId: args.storyId,
      agent: args.agent,
      lane: args.agent,
      reviewRunId: args.reviewRunId,
      identity: getSessionIdentity(),
      dispatch: dispatch.binding,
    }),
  });
}

function deliveryFixtureInvocation(args: {
  root: string;
  store: StoryStore;
  storyId: string;
}) {
  const dispatch = verifyCurrentDeliveryReviewDispatch({
    store: args.store,
    storyId: args.storyId,
    projectRoot: args.root,
  });
  if (!dispatch.ok) throw new Error(`native delivery fixture has no signed dispatch binding: ${dispatch.reason}`);
  const broker = nativeReviewFixtureBrokers().find(
    candidate => candidate.host === dispatch.binding.dispatch.hostRenderHost,
  );
  if (!broker) throw new Error(`native delivery fixture has no broker for ${dispatch.binding.dispatch.hostRenderHost}`);
  const writerSessionId = `native-delivery-fixture-${randomUUID()}`;
  const now = Date.now();
  return {
    attestation: signNativeReviewInvocationAttestation({
      schemaVersion: 'lattice.native_review_invocation_attestation.v1',
      brokerId: broker.brokerId,
      adapterId: broker.adapterId,
      host: broker.host,
      storyId: args.storyId,
      agent: DELIVERY_REVIEW_LANE,
      lane: DELIVERY_REVIEW_LANE,
      reviewRunId: dispatch.binding.invocationId,
      writerSessionId,
      dispatchPromptDigest: dispatch.binding.dispatch.dispatchPromptDigest,
      dispatchBindingDigest: dispatch.binding.dispatch.dispatchBindingDigest,
      hostRenderIdentityDigest: dispatch.binding.dispatch.hostRenderIdentityDigest,
      invocationNonce: randomUUID(),
      issuedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + 60_000).toISOString(),
    }, keys.privateKey),
    env: nativeReviewFixtureHostEnvironment(DELIVERY_REVIEW_LANE, broker.host, writerSessionId),
  };
}

/** Execute a delivery evidence write under the same real broker descriptor boundary. */
export function withBrokeredNativeDeliveryInvocation<T>(args: {
  root: string;
  store: StoryStore;
  storyId: string;
  invoke: () => T;
}): T {
  const invocation = deliveryFixtureInvocation(args);
  const path = join(args.root, `.native-delivery-fixture-${randomUUID()}.json`);
  writeFileSync(path, `${JSON.stringify(invocation.attestation)}\n`, { mode: 0o600 });
  const fd = openSync(path, 'r');
  const envKeys = [
    'LATTICE_NATIVE_REVIEW_ATTESTATION_FD',
    'PROOF_OR_STOP_SESSION_ID',
    'PROOF_OR_STOP_AGENT',
    'PROOF_OR_STOP_OWNER_SESSION_ADAPTER_PROVIDER',
    'PROOF_OR_STOP_OWNER_SESSION_ADAPTER_TASK',
    'PROOF_OR_STOP_OWNER_SESSION_ADAPTER_AGENT',
    'CLAUDE_CODE_SESSION_ID',
  ] as const;
  const previous = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
  try {
    process.env.LATTICE_NATIVE_REVIEW_ATTESTATION_FD = String(fd);
    Object.assign(process.env, invocation.env);
    resetSessionIdForTest();
    return args.invoke();
  } finally {
    resetSessionIdForTest();
    for (const key of envKeys) {
      const value = previous[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    closeSync(fd);
    unlinkSync(path);
  }
}
