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
import { isCanonicalStoryId } from '../core/lifecycle-registry.js';
import type { LatticeConfig } from '../core/config.js';

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

  if (cmd === 'plan_skeleton') {
    cls = args.write === true || args.write === 'true' ? 'storyScopedMutating' : 'readOnly';
  }

  if (cmd === 'evidence_refresh') {
    // B-4896 (P4): the dry preview default stays readOnly/ungated; --apply is the
    // sanctioned one-pass write path (verification_evidence_refresh_stale) and
    // MUST be ownership/scope gated so a foreign session cannot re-stamp evidence
    // (the P2 lesson: a writer left readOnly bypasses the owner gate).
    cls = args.apply === true || args.apply === 'true' ? 'storyScopedMutating' : 'readOnly';
  }

  if (cmd === 'live_smoke_transcript') {
    // B-9b5e (P5): the read-only status default AND --capture-without-write stay
    // readOnly/ungated for WRITES — --capture runs a command but writes no story
    // metadata, so it is NOT a storyScopedMutating write. Only --write persists the
    // transcript artifact and MUST be ownership/scope gated (the P2/P4 lesson: a
    // writer left readOnly bypasses the owner gate).
    cls = args.write === true || args.write === 'true' ? 'storyScopedMutating' : 'readOnly';
  }

  if (cmd === 'delivery_context_pack') {
    // P6: the read-only context-pack default stays readOnly/ungated. Only --write
    // persists the delivery-context-pack artifact and MUST be ownership/scope gated
    // (the P2/P4/P5 lesson: a writer left readOnly bypasses the owner gate). This is
    // a context PRODUCER, never a delivery signer — --write only writes the pack
    // artifact, never delivery-check.json.
    cls = args.write === true || args.write === 'true' ? 'storyScopedMutating' : 'readOnly';
  }

  if (cmd === 'usage_sweep') {
    // F-014: usage_sweep is a read-only diagnostic, but an explicit --out writes a
    // JSON report file INSIDE the project root. Mirror the --write boundary rules
    // (plan_skeleton/evidence_refresh/live_smoke_transcript/delivery_context_pack):
    // a non-empty --out is dynamically treated as storyScopedMutating so a read-only
    // reviewer session (LATTICE_REVIEWER_READONLY / retired root) can NOT create a
    // file in the material tree. Without --out it writes nothing and stays
    // readOnly/ungated (runnable by any session). The path is normalized the same
    // way the handler does (typeof string + trim) so a blank/whitespace --out is
    // NOT a write.
    const out = args.out;
    cls = typeof out === 'string' && out.trim().length > 0 ? 'storyScopedMutating' : 'readOnly';
  }

  if (cmd === 'done_prepare' && args.dryRun === true) {
    cls = 'readOnly';
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

const RETIRED_ROOT_BLOCKED_OWNERSHIP_CLASSES: ReadonlySet<OwnershipClass> = new Set([
  'storyScopedMutating',
  'reviewerWrite',
  'mainSharedMutating',
  'dangerousMutating',
]);

function canonicalRootFromConfig(config: Pick<LatticeConfig, 'canonicalRoot'>): string | null {
  if (typeof config.canonicalRoot !== 'string') return null;
  const trimmed = config.canonicalRoot.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function enforceRetiredRootGuard(
  cmd: string,
  args: Record<string, unknown>,
  config: Pick<LatticeConfig, 'retiredRoot' | 'canonicalRoot'>,
  activeStory: ActiveStoryForOwnershipGate | null,
  projectRoot: string,
): void {
  if (config.retiredRoot !== true) return;

  const storyId = storyIdFromArgs(args, activeStory, { command: cmd, projectRoot });
  const cls = resolveEffectiveOwnershipClass(cmd, args, storyId);

  if (cls === null) {
    throw new Error(
      `Retired Proofbound root guard cannot classify command "${cmd}" because command-policy.ts has no valid ownershipClass. ` +
      `Retired root: ${projectRoot}. Add a CommandPolicy.ownershipClass entry before running this command.`,
    );
  }
  if (!RETIRED_ROOT_BLOCKED_OWNERSHIP_CLASSES.has(cls)) return;

  const canonicalRoot = canonicalRootFromConfig(config);
  if (!canonicalRoot) {
    throw new Error(
      `Proofbound root is retired: ${projectRoot}\n` +
      `retiredRoot is true but canonicalRoot is not configured.\n` +
      `Use canonicalRoot: <configure canonicalRoot in lattice.config.json>\n` +
      `Fail-closed before mutating command "${cmd}" (${cls}). ` +
      `Add "canonicalRoot": "/path/to/canonical/project" to lattice.config.json, or set retiredRoot=false only in the active canonical project.`,
    );
  }

  throw new Error(
    `Proofbound root is retired: ${projectRoot}\n` +
    `Use canonicalRoot: ${canonicalRoot}\n` +
    `Command "${cmd}" resolves to ${cls} and is blocked before handler dispatch.\n` +
    `Run the mutating command from canonicalRoot, or use this retired root only for read-only legacy evidence inspection.`,
  );
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

  // F-003 (path traversal at the SHARED owner-lease gate): this gate is the
  // FIRST place a storyScopedMutating command's storyId is turned into a
  // filesystem path (store.storyDirPath → acquireOrRefreshOwnerLease writes
  // owner-lease.json into it), BEFORE any handler-level guard runs. A crafted
  // id such as `../../outside` would otherwise make the gate write
  // `.lattice/outside/owner-lease.json` OUTSIDE the story tree. Fail CLOSED on
  // any non-canonical id (the canonical shape is anchored + `[A-Za-z0-9_-]`
  // only, so it can never contain `/`, `\`, or `..`) so NO path is derived and
  // NO lease is written anywhere. Legitimate ids — the `--storyId` arg, an id
  // resolved from an autopilot runId file, or the active story's id — all match
  // the canonical shape (`B-<hex>` etc.), so this never regresses a real story.
  if (!isCanonicalStoryId(storyId)) {
    throw new Error(
      `Refusing to run owner-gated command "${cmd}": storyId ${JSON.stringify(storyId)} is not a ` +
      `valid Proofbound story id. A story id must match the canonical shape (e.g. B-xxxx) and may ` +
      `not contain a path separator or "..". This is rejected fail-closed before any story ` +
      `directory path is derived (path-traversal guard).`,
    );
  }

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
        `${storyId} is owned by another Proofbound session (${lease.sessionId}) whose owner lease is ` +
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
