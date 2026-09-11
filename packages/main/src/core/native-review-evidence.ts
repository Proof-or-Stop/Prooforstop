import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { basename } from 'node:path';

import type { SessionIdentity } from './owner-session.js';
import type { PromptHost } from './prompt-registry.js';
import type { NativeReviewEvidenceBinding } from './types.js';
import { digestCanonicalJson } from './digest.js';
import { loadConfig } from './config.js';
import {
  consumeNativeReviewInvocationAttestation,
  readNativeReviewInvocationAttestationFromFd,
  verifyNativeReviewInvocationAttestationConsumption,
  verifyNativeReviewInvocationAttestation,
  type NativeReviewBrokerRegistration,
  type SignedNativeReviewInvocationAttestation,
} from './native-review-attestation.js';

export interface NativeReviewDispatchAuthority {
  hostRenderHost: PromptHost;
  dispatchPromptDigest: string;
  hostRenderIdentityDigest: string;
  dispatchBindingDigest: string;
}

function promptHostForSession(identity: SessionIdentity): PromptHost | null {
  if (identity.hostProvider === 'codex') return 'codex';
  if (identity.hostProvider === 'claude-code') return 'claude';
  return null;
}

export interface NativeHostProcessObservation {
  host: PromptHost;
  processLineageDigest: string;
  providerFamilies?: PromptHost[];
  mixedProviderFamilies?: boolean;
}

export interface NativeHostProcessLineageRow {
  pid: number;
  ppid: number;
  comm: string;
  command: string;
}

function providerForProcess(comm: string, command: string): PromptHost | null {
  const executableNames = [basename(comm), basename(command.trim().split(/\s+/, 1)[0] ?? '')]
    .map(value => value.toLowerCase());
  if (executableNames.some(value => value === 'codex' || value.startsWith('codex-'))) return 'codex';
  if (executableNames.some(value => value === 'claude' || value === 'claude-code' || value.startsWith('claude-'))) return 'claude';
  return null;
}

function commandDigest(command: string): string {
  return `sha256:${createHash('sha256').update(command, 'utf8').digest('hex')}`;
}

/** Classify every visible provider family, retaining nearest-first order. */
export function classifyNativeHostProcessLineage(
  rows: readonly NativeHostProcessLineageRow[],
): NativeHostProcessObservation {
  const lineage = rows.map(row => ({
    pid: row.pid,
    ppid: row.ppid,
    comm: basename(row.comm),
    commandDigest: commandDigest(row.command),
  }));
  const providerFamilies: PromptHost[] = [];
  for (const row of rows) {
    const provider = providerForProcess(row.comm, row.command);
    if (provider && !providerFamilies.includes(provider)) providerFamilies.push(provider);
  }
  const host = providerFamilies[0];
  if (!host) throw new Error('native process lineage contains no Codex/Claude provider family');
  return {
    host,
    providerFamilies,
    mixedProviderFamilies: providerFamilies.length > 1,
    processLineageDigest: `sha256:${digestCanonicalJson({
      schemaVersion: 'lattice.native_review_process_lineage.v2',
      host,
      providerFamilies,
      lineage,
    })}`,
  };
}

/** Inspect the complete visible Codex/Claude ancestry; inherited env is not provenance. */
export function observeNativeHostProcess(startPid = process.ppid): NativeHostProcessObservation | null {
  if (process.platform === 'win32') return null;
  let pid = startPid;
  const lineage: NativeHostProcessLineageRow[] = [];
  const seen = new Set<number>();
  let complete = false;
  for (let depth = 0; depth < 32 && Number.isInteger(pid) && pid > 1 && !seen.has(pid); depth += 1) {
    seen.add(pid);
    let raw: string;
    try {
      raw = execFileSync('ps', ['-o', 'ppid=', '-o', 'comm=', '-o', 'command=', '-p', String(pid)], {
        encoding: 'utf8',
        timeout: 1_000,
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
    } catch {
      return null;
    }
    const match = raw.match(/^\s*(\d+)\s+(\S+)\s+(.+)$/s);
    if (!match) return null;
    const ppid = Number(match[1]);
    const comm = match[2] ?? '';
    const command = match[3] ?? '';
    lineage.push({ pid, ppid, comm, command });
    const classified = lineage.some(row => providerForProcess(row.comm, row.command))
      ? classifyNativeHostProcessLineage(lineage)
      : null;
    if (classified?.mixedProviderFamilies) return classified;
    if (ppid <= 1) {
      complete = true;
      break;
    }
    pid = ppid;
  }
  return complete && lineage.some(row => providerForProcess(row.comm, row.command))
    ? classifyNativeHostProcessLineage(lineage)
    : null;
}

function trustedNativeReviewBrokers(projectRoot: string): NativeReviewBrokerRegistration[] {
  return (loadConfig(projectRoot).nativeReviewInvocation?.brokers ?? []).filter(
    (broker): broker is NativeReviewBrokerRegistration =>
      typeof broker.brokerId === 'string'
      && typeof broker.adapterId === 'string'
      && (broker.host === 'codex' || broker.host === 'claude')
      && typeof broker.publicKey === 'string',
  );
}

/**
 * Consume a one-shot invocation attestation signed by a separately registered
 * host adapter/broker. OS ancestry is only corroboration: an unavailable
 * process table does not negate a valid broker signature, while any visible
 * mixed Codex/Claude lineage is an unconditional cross-provider veto.
 */
export function issueNativeReviewEvidenceBinding(args: {
  projectRoot: string;
  storyId: string;
  agent: string;
  lane: string;
  reviewRunId: string;
  identity: SessionIdentity;
  dispatch: NativeReviewDispatchAuthority;
  attestation?: SignedNativeReviewInvocationAttestation;
  trustedBrokers?: readonly NativeReviewBrokerRegistration[];
  observeProcess?: () => NativeHostProcessObservation | null;
}): NativeReviewEvidenceBinding {
  const nativeHost = promptHostForSession(args.identity);
  if (nativeHost === null || !args.identity.nativeSessionRef) {
    throw new Error('native reviewer authority requires a supported host-adapter identity (codex or claude-code)');
  }
  if (nativeHost !== args.dispatch.hostRenderHost) {
    throw new Error(
      `cross-provider direct reviewer evidence is advisory-only: current environment host=${nativeHost}, `
      + `signed dispatch host=${args.dispatch.hostRenderHost}; use cross_host_review/host_run managed reviewer evidence`,
    );
  }
  const attestation = args.attestation ?? readNativeReviewInvocationAttestationFromFd();
  if (!attestation) {
    throw new Error(
      'native reviewer authority requires a registered host-adapter invocation attestation; '
      + 'without an adapter broker, direct evidence is advisory-only and formal review must use managed reviewer evidence',
    );
  }
  const trustedBrokers = args.trustedBrokers ?? trustedNativeReviewBrokers(args.projectRoot);
  const verified = consumeNativeReviewInvocationAttestation({
    projectRoot: args.projectRoot,
    attestation,
    trustedBrokers,
    expected: {
      host: nativeHost,
      storyId: args.storyId,
      agent: args.agent,
      lane: args.lane,
      reviewRunId: args.reviewRunId,
      writerSessionId: args.identity.sessionId,
      dispatchPromptDigest: args.dispatch.dispatchPromptDigest,
      dispatchBindingDigest: args.dispatch.dispatchBindingDigest,
      hostRenderIdentityDigest: args.dispatch.hostRenderIdentityDigest,
    },
  });
  if (!verified.ok) {
    throw new Error(`native reviewer invocation attestation rejected: ${verified.reason}`);
  }
  const observedProcess = (args.observeProcess ?? observeNativeHostProcess)();
  if (observedProcess?.mixedProviderFamilies) {
    throw new Error(
      `cross-provider direct reviewer evidence is advisory-only: mixed provider ancestry=${(observedProcess.providerFamilies ?? []).join('->')}; `
      + 'use cross_host_review/host_run managed reviewer evidence',
    );
  }
  if (observedProcess && observedProcess.host !== nativeHost) {
    throw new Error(
      `cross-provider direct reviewer evidence is advisory-only: current environment host=${nativeHost}, `
      + `nearest provider process=${observedProcess.host}; use cross_host_review/host_run managed reviewer evidence`,
    );
  }
  return {
    schemaVersion: 'lattice.native_review_evidence_binding.v2',
    host: nativeHost,
    storyId: args.storyId,
    agent: args.agent,
    lane: args.lane,
    reviewRunId: args.reviewRunId,
    dispatchPromptDigest: args.dispatch.dispatchPromptDigest,
    dispatchBindingDigest: args.dispatch.dispatchBindingDigest,
    hostRenderIdentityDigest: args.dispatch.hostRenderIdentityDigest,
    writerSessionId: args.identity.sessionId,
    sessionSource: args.identity.sessionSource,
    brokerId: attestation.brokerId,
    adapterId: attestation.adapterId,
    invocationNonce: attestation.invocationNonce,
    attestationDigest: verified.attestationDigest,
    attestation,
    ...(observedProcess ? { processLineageDigest: observedProcess.processLineageDigest } : {}),
    ...(args.identity.nativeSessionRef ? { nativeSessionRef: args.identity.nativeSessionRef } : {}),
  };
}

export function verifyNativeReviewEvidenceBinding(args: {
  binding: NativeReviewEvidenceBinding;
  projectRoot: string;
  storyId: string;
  agent: string;
  lane: string;
  reviewRunId: string;
  dispatch: NativeReviewDispatchAuthority;
  writerSessionId?: string;
  sessionSource?: string;
}): boolean {
  if (args.binding.schemaVersion !== 'lattice.native_review_evidence_binding.v2'
    || args.binding.host !== args.dispatch.hostRenderHost
    || args.binding.storyId !== args.storyId
    || args.binding.agent !== args.agent
    || args.binding.lane !== args.lane
    || args.binding.reviewRunId !== args.reviewRunId
    || args.binding.dispatchPromptDigest !== args.dispatch.dispatchPromptDigest
  ) return false;
  if (args.binding.dispatchBindingDigest !== args.dispatch.dispatchBindingDigest
    || args.binding.hostRenderIdentityDigest !== args.dispatch.hostRenderIdentityDigest
    || (args.binding.processLineageDigest !== undefined
      && !/^sha256:[a-f0-9]{64}$/.test(args.binding.processLineageDigest))
    || args.binding.writerSessionId.trim().length === 0
    || args.binding.writerSessionId !== args.writerSessionId
    || args.binding.sessionSource !== args.sessionSource
    || args.binding.brokerId !== args.binding.attestation.brokerId
    || args.binding.adapterId !== args.binding.attestation.adapterId
    || args.binding.invocationNonce !== args.binding.attestation.invocationNonce) return false;
  const verified = verifyNativeReviewInvocationAttestation({
    attestation: args.binding.attestation,
    trustedBrokers: trustedNativeReviewBrokers(args.projectRoot),
    expected: {
      host: args.binding.host,
      storyId: args.storyId,
      agent: args.agent,
      lane: args.lane,
      reviewRunId: args.reviewRunId,
      writerSessionId: args.binding.writerSessionId,
      dispatchPromptDigest: args.dispatch.dispatchPromptDigest,
      dispatchBindingDigest: args.dispatch.dispatchBindingDigest,
      hostRenderIdentityDigest: args.dispatch.hostRenderIdentityDigest,
    },
    requireFresh: false,
  });
  if (!verified.ok || verified.attestationDigest !== args.binding.attestationDigest) return false;
  return verifyNativeReviewInvocationAttestationConsumption({
    projectRoot: args.projectRoot,
    attestation: args.binding.attestation,
    attestationDigest: verified.attestationDigest,
  }).ok;
}
