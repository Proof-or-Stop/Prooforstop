/**
 * Ledger-independent provider-process admission.
 *
 * Usage accounting may be disabled, but every Lattice-owned provider spawn
 * still competes for the same atomic slot registry. This module is the small
 * adapter used by all Lattice-owned provider launch sites.
 */

import {
  acquireProviderProcessSlot,
  providerProcessSlotsDir,
  releaseProviderProcessSlotBestEffort,
  resolveProviderProcessMaxConcurrent,
  resolveProviderProcessSlotStaleMs,
  scanLiveProviderProcessSlots,
  transferProviderProcessSlotToProvider,
  type AcquiredProviderProcessSlot,
  type ProviderProcessLiveDescriptor,
  type ProviderRegistryLockTiming,
  type ProviderRegistryMutationOps,
} from './provider-process-registry.js';

export interface ProviderProcessAdmissionRequest {
  root: string;
  env: NodeJS.ProcessEnv;
  host: string;
  storyId: string | null;
  agentType: string;
  startedAt?: string;
  pid?: number;
}

export interface ProviderProcessAdmission {
  admitted: boolean;
  slot: AcquiredProviderProcessSlot | null;
  cap: number;
  liveRuns: ProviderProcessLiveDescriptor[];
}

/** Internal release seam; production callers use the fail-safe defaults. */
export interface ProviderProcessAdmissionReleaseOptions {
  onFailure?: (error: unknown) => void;
  lockTiming?: ProviderRegistryLockTiming;
  mutationOps?: ProviderRegistryMutationOps;
}

export function acquireProviderProcessAdmission(
  request: ProviderProcessAdmissionRequest,
): ProviderProcessAdmission {
  const dir = providerProcessSlotsDir(request.root);
  const cap = resolveProviderProcessMaxConcurrent(request.env);
  const staleMs = resolveProviderProcessSlotStaleMs(request.env);
  const slot = acquireProviderProcessSlot(dir, cap, staleMs, Date.now(), {
    pid: request.pid ?? process.pid,
    startedAt: request.startedAt ?? new Date().toISOString(),
    host: request.host,
    storyId: request.storyId,
    agentType: request.agentType,
  });
  return {
    admitted: slot !== null,
    slot,
    cap,
    // B-137a:F-126 — DIAGNOSTIC-ONLY, and deliberately a post-refusal snapshot.
    //
    // The admission DECISION is already made above, atomically under the
    // registry lock. This scan runs after that lock is released, with a fresh
    // Date.now(), so it can legitimately disagree with the decision: a slot
    // freed in between makes the list shorter than `cap` even though the
    // refusal was correct at decision time. That is why it never feeds a gate.
    //
    // Holding the lock across the scan would make the two agree but would
    // serialize every refusal behind a directory walk, adding contention to the
    // exact path that is already saturated. The snapshot is described as
    // approximate at its user-facing consumer (host-run.ts refusalDetail)
    // instead of being presented as an authoritative count.
    liveRuns: slot ? [] : scanLiveProviderProcessSlots(dir, Date.now(), staleMs),
  };
}

export function releaseProviderProcessAdmission(
  admission: ProviderProcessAdmission | null,
  options: ProviderProcessAdmissionReleaseOptions = {},
): void {
  if (!admission?.slot) return;
  releaseProviderProcessSlotBestEffort(
    admission.slot.file,
    admission.slot.token,
    options.onFailure,
    options.lockTiming,
    options.mutationOps,
  );
}

export function transferProviderProcessAdmissionToProvider(
  admission: ProviderProcessAdmission | null,
  identity: {
    pid: number;
    pgid: number | null;
    spawnedAt: string;
    startFingerprint: string | null;
    processGroupIsolated: boolean;
  },
): boolean {
  if (!admission?.slot) return false;
  return transferProviderProcessSlotToProvider(admission.slot.file, admission.slot.token, identity);
}
