import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { StoryStore } from '../core/store.js';
import {
  acquireOrRefreshOwnerLease,
  formatLeaseAge,
  formatNonOwnerError,
  getSessionId,
  takeOverOwnerLease,
} from '../core/story-owner-lease.js';
import { getCommandPolicy, isOwnershipClass, type OwnershipClass } from '../core/command-policy.js';
import { LATTICE_DIR } from '../core/lattice-paths.js';

export interface ActiveStoryForOwnershipGate {
  storyId: string;
  phase?: string;
}

export function ownerLeaseHelpBlock(cmd: string): string | null {
  const policy = getCommandPolicy(cmd);
  if (!policy || !isOwnershipClass(policy.ownershipClass)) return null;
  const cls = policy.ownershipClass;
  if (cls === 'readOnly' || cls === 'reviewerWrite' || cls === 'mainSharedMutating') return null;
  const note = cmd === 'validate'
    ? ' (applies when --story is supplied; diagnostic validate without --story is always read-only)'
    : '';
  return [
    ``,
    `  Owner lease meta options${note}:`,
    `    --takeover          recover a stale foreign lease (no heartbeat for 30+ min)`,
    `    --forceTakeover     seize an active foreign lease (deliberate human override; also transfers stale)`,
  ].join('\n');
}

const AUTOPILOT_RUN_OWNER_GATED_COMMANDS = new Set([
  'autopilot_cancel',
  'autopilot_resume',
]);

function safeAutopilotRunId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return /^[a-zA-Z0-9_.-]{1,128}$/.test(trimmed) ? trimmed : null;
}

export function storyIdFromAutopilotRunId(projectRoot: string, args: Record<string, unknown>): string | null {
  const runId = safeAutopilotRunId(args.runId ?? args.autopilotId);
  if (!runId) return null;
  const file = [
    join(projectRoot, LATTICE_DIR, 'autopilot-runs', runId, 'run.json'),
  ].find((candidate) => existsSync(candidate));
  if (!file) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as { storyId?: unknown };
    return typeof parsed.storyId === 'string' && parsed.storyId.trim()
      ? parsed.storyId.trim()
      : null;
  } catch {
    return null;
  }
}

export function storyIdFromArgs(
  args: Record<string, unknown>,
  activeStory?: ActiveStoryForOwnershipGate | null,
  context?: { command?: string; projectRoot?: string },
): string | null {
  if (typeof args.storyId === 'string' && args.storyId.trim()) return args.storyId.trim();
  if (typeof args.story === 'string' && args.story.trim()) return args.story.trim();
  if (
    context?.command &&
    context.projectRoot &&
    AUTOPILOT_RUN_OWNER_GATED_COMMANDS.has(context.command)
  ) {
    const runStoryId = storyIdFromAutopilotRunId(context.projectRoot, args);
    if (runStoryId) return runStoryId;
  }
  return activeStory?.storyId || null;
}

export function resolveEffectiveOwnershipClass(
  cmd: string,
  args: Record<string, unknown>,
  storyId: string | null,
): OwnershipClass | null {
  const policy = getCommandPolicy(cmd);
  if (!policy || !isOwnershipClass(policy.ownershipClass)) return null;
  let cls: OwnershipClass = policy.ownershipClass;

  if ((cmd === 'finding_resolve' || cmd === 'finding_dismiss') && storyId && storyId.startsWith('B-META-')) {
    cls = 'mainSharedMutating';
  }

  if (cmd === 'validate') {
    const hasStory =
      (typeof args.story === 'string' && args.story.trim().length > 0) ||
      (typeof args.storyId === 'string' && args.storyId.trim().length > 0);
    cls = hasStory ? 'storyScopedMutating' : 'readOnly';
  }

  if (cmd === 'delivery_check_set') {
    cls = isDeliveryReviewerActor(args) ? 'reviewerWrite' : 'storyScopedMutating';
  }

  if (cmd === 'dev_memory_finish') {
    const hasExplicitStory =
      (typeof args.story === 'string' && args.story.trim().length > 0) ||
      (typeof args.storyId === 'string' && args.storyId.trim().length > 0);
    if (!hasExplicitStory && args.scope === 'global') {
      cls = 'mainSharedMutating';
    }
  }

  return cls;
}

export function isDeliveryReviewerActor(args: Record<string, unknown>): boolean {
  const explicit = typeof args.agentId === 'string' ? args.agentId.trim() : '';
  const env = typeof process.env.LATTICE_AGENT === 'string' ? process.env.LATTICE_AGENT.trim() : '';
  const actor = explicit || env;
  return actor === 'lattice-review-delivery';
}

export type TakeoverIntent = 'none' | 'takeover' | 'forceTakeover';

export function resolveTakeoverIntent(args: Record<string, unknown>): TakeoverIntent {
  const isSet = (v: unknown): boolean => v === true || v === 'true';
  if (isSet(args.forceTakeover)) return 'forceTakeover';
  if (isSet(args.takeover)) return 'takeover';
  return 'none';
}

export function enforceStoryOwnerLeaseGate(
  cmd: string,
  args: Record<string, unknown>,
  store: StoryStore,
  activeStory: ActiveStoryForOwnershipGate | null,
  projectRoot: string,
): void {
  const storyId = storyIdFromArgs(args, activeStory, { command: cmd, projectRoot });
  const cls = resolveEffectiveOwnershipClass(cmd, args, storyId);

  if (cls === null) {
    throw new Error(
      `Command "${cmd}" has no valid ownershipClass in command-policy.ts and is rejected fail-closed. ` +
      `Every registered command must declare a CommandPolicy.ownershipClass (readOnly / storyScopedMutating / ` +
      `reviewerWrite / mainSharedMutating / dangerousMutating). Add a classified policy entry and rerun.`,
    );
  }

  if (cls === 'readOnly' || cls === 'reviewerWrite' || cls === 'mainSharedMutating') {
    return;
  }

  if (!storyId) return;
  const storyDir = store.storyDirPath(storyId);
  if (!existsSync(storyDir)) return;

  const { lease, action } = acquireOrRefreshOwnerLease(storyDir, {
    command: cmd,
    cwd: process.cwd(),
  });

  if (action !== 'foreign') return;

  const intent = resolveTakeoverIntent(args);
  if (intent !== 'none') {
    const result = takeOverOwnerLease(storyDir, {
      kind: intent,
      command: cmd,
      cwd: process.cwd(),
      projectRoot,
    });
    if (result.transferred) {
      return;
    }
    if (result.reason === 'lease-active') {
      const activeAgeMs = Date.now() - Date.parse(lease.heartbeatAt);
      const activeAge = Number.isFinite(activeAgeMs) ? formatLeaseAge(activeAgeMs) : 'unknown';
      throw new Error(
        `${storyId} is owned by another Lattice session (${lease.sessionId}) whose owner lease is ` +
        `still ACTIVE (heartbeat ${activeAge} ago). --takeover only transfers a STALE lease ` +
        `(no heartbeat for 30+ minutes). To seize an active session's lock, rerun with ` +
        `--forceTakeover — a deliberate human override.`,
      );
    }
  }

  throw new Error(
    formatNonOwnerError(lease, {
      storyId,
      command: cmd,
      ownershipClass: cls,
      currentSessionId: getSessionId(),
      currentCwd: process.cwd(),
    }),
  );
}
