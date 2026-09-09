/**
 * Ledger-independent provider-process admission.
 *
 * Usage accounting may be disabled, but every Lattice-owned provider spawn
 * still competes for the same atomic slot registry. This module is the small
 * adapter used by all Lattice-owned provider launch sites.
 */

import { MACHINE_PROVIDER_ADMISSION_RUNTIME_POLICY } from './runtime-fact-registry.js';
import {
  acquireProviderProcessSlot,
  machineProviderProcessSlotsDir,
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
  machineSlot?: AcquiredProviderProcessSlot | null;
  capacityScope?: 'project' | 'machine';
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
  if (!slot) return { admitted: false, slot: null, cap, capacityScope: 'project',
    liveRuns: scanLiveProviderProcessSlots(dir, Date.now(), staleMs) };
  // Local first, machine second. A machine refusal never retains a local slot.
  // Each registry's decision is atomic; diagnostic scans remain post-refusal.
  let machineSlot: AcquiredProviderProcessSlot | null = null;
  try {
    const machineDir = machineProviderProcessSlotsDir();
    const machineCap = MACHINE_PROVIDER_ADMISSION_RUNTIME_POLICY.maxConcurrent;
    machineSlot = acquireProviderProcessSlot(machineDir, machineCap, staleMs, Date.now(), {
      pid: request.pid ?? process.pid, startedAt: request.startedAt ?? new Date().toISOString(),
      host: request.host, storyId: request.storyId, agentType: request.agentType,
    });
    if (!machineSlot) return { admitted: false, slot: null, machineSlot: null, cap: machineCap, capacityScope: 'machine',
      liveRuns: scanLiveProviderProcessSlots(machineDir, Date.now(), staleMs) };
    return { admitted: true, slot, machineSlot, cap: Math.min(cap, machineCap), liveRuns: [] };
  } finally {
    if (!machineSlot) releaseProviderProcessSlotBestEffort(slot.file, slot.token);
  }
}

export function releaseProviderProcessAdmission(
  admission: ProviderProcessAdmission | null,
  options: ProviderProcessAdmissionReleaseOptions = {},
): void {
  if (!admission) return;
  try {
    if (admission.slot) releaseProviderProcessSlotBestEffort(admission.slot.file, admission.slot.token,
      options.onFailure, options.lockTiming, options.mutationOps);
  } finally {
    if (admission.machineSlot) releaseProviderProcessSlotBestEffort(admission.machineSlot.file, admission.machineSlot.token,
      options.onFailure, options.lockTiming, options.mutationOps);
  }
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
  if (!transferProviderProcessSlotToProvider(admission.slot.file, admission.slot.token, identity)) return false;
  return !admission.machineSlot || transferProviderProcessSlotToProvider(admission.machineSlot.file, admission.machineSlot.token, identity);
}
