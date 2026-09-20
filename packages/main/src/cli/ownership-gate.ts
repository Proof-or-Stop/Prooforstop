import { isMaintenancePreviewCommand, maintenanceCommandWrites } from '../core/maintenance-command-mode.js';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { StoryStore } from '../core/store.js';
import {
  acquireOrRefreshOwnerLease,
  formatLeaseAge,
  formatNonOwnerError,
  getSessionId,
  isLeaseStale,
  readOwnerLease,
  takeOverOwnerLease,
} from '../core/story-owner-lease.js';
import { getCommandPolicy, isOwnershipClass, type OwnershipClass } from '../core/command-policy.js';
import { PROOF_OR_STOP_DIR } from '../core/proof-or-stop-paths.js';
import { isCanonicalStoryId } from '../core/lifecycle-registry.js';
import type { ProofOrStopConfig } from '../core/config.js';
import { isManagedImplementerCompletionPayload, managedHostRunStoryIdForOwnership, resolveManagedImplementerCompletionInvocation } from '../core/managed-host-run.js';
import { readBrandEnv } from '../core/brand-env.js';
import { resolveRegisteredAgentActor } from '../core/agent-dispatch-registry.js';
import { agentRoleIdsEqual } from '../core/agent-role-identity.js';

export interface ActiveStoryForOwnershipGate {
  storyId: string;
  phase?: string;
}

/**
 * Ownership declarations supplied by a package that extends `runCli` with
 * extra tools. Core commands remain fail-closed against COMMAND_POLICIES;
 * an extension command is classified only when its launcher supplies an exact
 * command-name row here.
 */
export type ExternalCommandOwnershipClasses = Readonly<Record<string, OwnershipClass>>;

export function ownerLeaseHelpBlock(cmd: string): string | null {
  const policy = getCommandPolicy(cmd);
  if (!policy || !isOwnershipClass(policy.ownershipClass)) return null;
  const refreshWriter = policy.storyWriteEffect === 'whenRefresh' &&
    resolveEffectiveOwnershipClass(cmd, { refresh: true }, null) === 'storyScopedMutating';
  const cls = refreshWriter ? 'storyScopedMutating' : policy.ownershipClass;
  if (cls === 'readOnly' || cls === 'reviewerWrite' || cls === 'mainSharedMutating') return null;
  const note = cmd === 'validate'
    ? ' (applies when --story is supplied; diagnostic validate without --story is always read-only)'
    : refreshWriter
      ? ' (applies when --refresh is supplied; default status remains read-only)'
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

const MANAGED_RUN_OWNER_GATED_COMMANDS = new Set([
  'host_run_status',
  'host_run_cancel',
  'host_run_worker',
  'managed_review_evidence_import',
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
    join(projectRoot, PROOF_OR_STOP_DIR, 'autopilot-runs', runId, 'run.json'),
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
  if (context?.command && context.projectRoot && MANAGED_RUN_OWNER_GATED_COMMANDS.has(context.command)) {
    if (context.command === 'host_run_status' && args.targets !== undefined) {
      if (!Array.isArray(args.targets) || args.targets.length < 1 || args.targets.length > 32) {
        throw new Error('host_run_status: targets must contain 1 to 32 runs');
      }
      const subjects = new Set(args.targets.map(target => {
        const runId = safeAutopilotRunId(target?.runId);
        if (!runId) throw new Error('host_run_status: invalid target runId');
        return managedHostRunStoryIdForOwnership(context.projectRoot!, runId);
      }));
      if (subjects.size !== 1) throw new Error('host_run_status: aggregate targets must share one immutable Story ownership subject');
      return [...subjects][0];
    }
    const runId = safeAutopilotRunId(args.runId);
    if (!runId) return null;
    return managedHostRunStoryIdForOwnership(context.projectRoot, runId);
  }
  return activeStory?.storyId || null;
}

export function resolveEffectiveOwnershipClass(
  cmd: string,
  args: Record<string, unknown>,
  storyId: string | null,
  externalOwnershipClasses?: ExternalCommandOwnershipClasses,
  runtimeContext?: {
    config?: Pick<ProofOrStopConfig, 'promptEnvelope' | 'browser' | 'cli'>;
  },
): OwnershipClass | null {
  const policy = getCommandPolicy(cmd);
  const declaredClass = policy?.ownershipClass ?? externalOwnershipClasses?.[cmd];
  if (!isOwnershipClass(declaredClass)) return null;
  let cls: OwnershipClass = declaredClass;

  if (isMaintenancePreviewCommand(cmd)) {
    return maintenanceCommandWrites(cmd, args, true) ? declaredClass : 'readOnly';
  }

  if (['finding_resolve', 'finding_dismiss', 'finding_route_accept', 'finding_route_reject', 'finding_route_revoke', 'finding_progress_capture'].includes(cmd)
    && storyId && storyId.startsWith('B-META-')) {
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
    // reviewer session (PROOF_OR_STOP_REVIEWER_READONLY / retired root) can NOT create a
    // file in the material tree. Without --out it writes nothing and stays
    // readOnly/ungated (runnable by any session). The path is normalized the same
    // way the handler does (typeof string + trim) so a blank/whitespace --out is
    // NOT a write.
    const out = args.out;
    cls = typeof out === 'string' && out.trim().length > 0 ? 'storyScopedMutating' : 'readOnly';
  }

  if (cmd === 'signature_backfill') {
    // Default is a report-only scan. Only --apply reaches writeFindings.
    cls = args.apply === true || args.apply === 'true' ? 'mainSharedMutating' : 'readOnly';
  }

  if (cmd === 'identity_state_migrate') {
    // Without --confirm the migrator only validates and renders its plan.
    cls = args.confirm === true || args.confirm === 'true' ? 'mainSharedMutating' : 'readOnly';
  }

  if (cmd === 'reviewer_list') {
    // Plain reviewer discovery is observational. --forceReviewer appends
    // reviewer_forced events to the selected Story and therefore needs the
    // owner/runtime write gates.
    const forced = args.forceReviewer;
    cls = typeof forced === 'string' && forced.trim().length > 0 ? 'storyScopedMutating' : 'readOnly';
  }

  if (cmd === 'certification_window_status' || cmd === 'review_inventory_status') {
    // Default status performs a read-only drift preflight. Only explicit
    // refresh may persist the detected INVALIDATED state.
    cls = args.refresh === true || args.refresh === 'true' ? 'storyScopedMutating' : 'readOnly';
  }

  if (cmd === 'doctor') {
    // Health inspection writes nothing by default. Only explicit repair can
    // clean shared worktree state or append Story cleanup events.
    cls = args.repair === true || args.repair === 'true' ? 'mainSharedMutating' : 'readOnly';
  }

  if (cmd === 'check') {
    const flag = (name: 'apply' | 'upgrade', value: unknown): boolean => {
      if (value === undefined || value === false || value === 'false') return false;
      if (value === true || value === 'true') return true;
      throw new Error(`check: ${name} must be a boolean`);
    };
    const apply = flag('apply', args.apply), upgrade = flag('upgrade', args.upgrade);
    cls = apply || upgrade ? 'mainSharedMutating' : 'readOnly';
  }

  if (cmd === 'agent_prompt') {
    const role = typeof args.role === 'string' ? args.role.trim() : '';
    // The handler enters its Story-writing path only for an explicit storyId.
    // Do not let the active-Story fallback turn a role-only prompt lookup into
    // a mutating command inside a Story worktree.
    const hasStory = typeof args.storyId === 'string' && args.storyId.trim().length > 0;
    const explicitAuditWrite = args.auditExperiment === true || args.auditExperiment === 'true';
    // CLI callers always supply config. An embedding that omits it is treated
    // conservatively for Story-aware calls so an unknown rollout cannot bypass
    // write admission; role-only prompt lookup remains unconditionally readOnly.
    const unknownStoryMode = hasStory && runtimeContext?.config === undefined;
    const readOnly = args.readOnly === true || args.readOnly === 'true';
    cls = hasStory && (!readOnly || explicitAuditWrite || args.experimentalModeOverride !== undefined) && (role.length > 0 || explicitAuditWrite || unknownStoryMode)
      ? 'storyScopedMutating'
      : 'readOnly';
  }

  if (cmd === 'evaluate') {
    const config = runtimeContext?.config;
    const hasEvaluatorTarget = Boolean(config?.browser?.devCommand || config?.cli?.command);
    // evaluate requires a Story id at the schema boundary. With known config it
    // writes only for the full-envelope + evaluator-target combination. Unknown
    // embedding config fails closed instead of assuming the handler is read-only.
    cls = config === undefined || hasEvaluatorTarget
      ? 'storyScopedMutating'
      : 'readOnly';
  }

  if (cmd === 'done_prepare' && args.dryRun === true) {
    cls = 'readOnly';
  }

  // checklist_update intentionally retains owner gating, including reviewed
  // intent proposals. A declared role is never a lease exemption for that writer.
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

function rawRuntimeAdmissionArgs(rawArgs: readonly string[]): Record<string, unknown> | null {
  if (rawArgs.length === 0) return {};
  if (rawArgs.length === 1 && rawArgs[0].startsWith('{')) {
    try {
      const parsed = JSON.parse(rawArgs[0]);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : null;
    } catch {
      return null;
    }
  }

  const parsed: Record<string, unknown> = {};
  const keyFrom = (raw: string): string => raw
    .replace(/^--?/, '')
    .replace(/-([a-z])/g, (_match, letter: string) => letter.toUpperCase());
  for (let index = 0; index < rawArgs.length; index += 1) {
    const token = rawArgs[index];
    const equal = token.indexOf('=');
    if (equal > 0) {
      const key = keyFrom(token.slice(0, equal));
      const value = token.slice(equal + 1);
      parsed[key] = value === 'true' ? true : value === 'false' ? false : value;
      continue;
    }
    if (!token.startsWith('-')) return null;
    const key = keyFrom(token);
    const next = rawArgs[index + 1];
    if (next !== undefined && !next.startsWith('-')) {
      parsed[key] = next === 'true' ? true : next === 'false' ? false : next;
      index += 1;
    } else {
      parsed[key] = true;
    }
  }
  return parsed;
}

/**
 * Resolve the earliest runtime-admission decision from untrusted raw argv.
 * Dynamic commands keep their genuinely read-only forms available, while
 * malformed/ambiguous argv falls back to the declared (usually mutating)
 * ownership class and therefore fails closed.
 */
export function resolveRawRuntimeAdmissionOwnership(
  cmd: string,
  rawArgs: readonly string[],
  externalOwnershipClasses?: ExternalCommandOwnershipClasses,
  runtimeContext?: {
    config?: Pick<ProofOrStopConfig, 'promptEnvelope' | 'browser' | 'cli'>;
  },
): OwnershipClass | null {
  const declared = getCommandPolicy(cmd)?.ownershipClass ?? externalOwnershipClasses?.[cmd];
  if (!isOwnershipClass(declared)) return null;
  const parsed = rawRuntimeAdmissionArgs(rawArgs);
  if (!parsed) return declared;
  const storyId = storyIdFromArgs(parsed, null);
  return resolveEffectiveOwnershipClass(cmd, parsed, storyId, externalOwnershipClasses, runtimeContext);
}

const RETIRED_ROOT_BLOCKED_OWNERSHIP_CLASSES: ReadonlySet<OwnershipClass> = new Set([
  'storyScopedMutating',
  'reviewerWrite',
  'mainSharedMutating',
  'dangerousMutating',
]);

function canonicalRootFromConfig(config: Pick<ProofOrStopConfig, 'canonicalRoot'>): string | null {
  if (typeof config.canonicalRoot !== 'string') return null;
  const trimmed = config.canonicalRoot.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function enforceRetiredRootGuard(
  cmd: string,
  args: Record<string, unknown>,
  config: Pick<ProofOrStopConfig, 'retiredRoot' | 'canonicalRoot' | 'promptEnvelope' | 'browser' | 'cli'>,
  activeStory: ActiveStoryForOwnershipGate | null,
  projectRoot: string,
  externalOwnershipClasses?: ExternalCommandOwnershipClasses,
): void {
  if (config.retiredRoot !== true) return;

  const storyId = storyIdFromArgs(args, activeStory, { command: cmd, projectRoot });
  const cls = resolveEffectiveOwnershipClass(cmd, args, storyId, externalOwnershipClasses, { config });

  if (cls === null) {
    throw new Error(
      `Retired Proof-or-Stop root guard cannot classify command "${cmd}" because command-policy.ts has no valid ownershipClass. ` +
      `Retired root: ${projectRoot}. Add a CommandPolicy.ownershipClass entry before running this command.`,
    );
  }
  if (!RETIRED_ROOT_BLOCKED_OWNERSHIP_CLASSES.has(cls)) return;

  const canonicalRoot = canonicalRootFromConfig(config);
  if (!canonicalRoot) {
    throw new Error(
      `Proof-or-Stop root is retired: ${projectRoot}\n` +
      `retiredRoot is true but canonicalRoot is not configured.\n` +
      `Use canonicalRoot: <configure canonicalRoot in proof-or-stop.config.json>\n` +
      `Fail-closed before mutating command "${cmd}" (${cls}). ` +
      `Add "canonicalRoot": "/path/to/canonical/project" to proof-or-stop.config.json, or set retiredRoot=false only in the active canonical project.`,
    );
  }

  throw new Error(
    `Proof-or-Stop root is retired: ${projectRoot}\n` +
    `Use canonicalRoot: ${canonicalRoot}\n` +
    `Command "${cmd}" resolves to ${cls} and is blocked before handler dispatch.\n` +
    `Run the mutating command from canonicalRoot, or use this retired root only for read-only legacy evidence inspection.`,
  );
}

export function isDeliveryReviewerActor(args: Record<string, unknown>): boolean {
  const explicit = typeof args.agentId === 'string' ? args.agentId.trim() : '';
  const envAgent = readBrandEnv('AGENT');
  const env = typeof envAgent === 'string' ? envAgent.trim() : '';
  const actor = explicit || env;
  return agentRoleIdsEqual(actor, 'proof-or-stop-review-delivery');
}

export type TakeoverIntent = 'none' | 'takeover' | 'forceTakeover';

export function resolveTakeoverIntent(args: Record<string, unknown>): TakeoverIntent {
  const isSet = (v: unknown): boolean => v === true || v === 'true';
  if (isSet(args.forceTakeover)) return 'forceTakeover';
  if (isSet(args.takeover)) return 'takeover';
  return 'none';
}

/**
 * A managed implementer is not the Story owner. It may, however, redeem the
 * controller's one-shot run capability for the single completion write that
 * the managed-dispatch contract requires. Keep this admission narrower than
 * checklist_update's schema: no definition, intent, evidence, actor, reason,
 * takeover, or lifecycle mutation can travel through this seam.
 */
function admitsManagedImplementerCompletion(
  cmd: string,
  args: Record<string, unknown>,
  projectRoot: string,
  storyId: string,
): boolean {
  if (cmd !== 'checklist_update'
    || args.status !== 'done'
    || args.success === false
    || typeof args.itemId !== 'string'
    || !args.itemId.trim()) return false;
  // Keep the lease exception visibly fail-closed at the admission seam. The
  // resolver repeats this shared predicate so a direct handler call cannot
  // drift into a managed completion after the gate decision.
  if (!isManagedImplementerCompletionPayload(args, storyId, args.itemId)) return false;
  const actor = readBrandEnv('AGENT')?.trim();
  if (!actor || !agentRoleIdsEqual(actor, 'proof-or-stop-implementer')) return false;
  return resolveManagedImplementerCompletionInvocation({
    root: projectRoot,
    storyId,
    itemId: args.itemId,
    payload: args,
    optionalWhenAbsent: true,
    consume: false,
  }) !== undefined;
}

export function enforceStoryOwnerLeaseGate(
  cmd: string,
  args: Record<string, unknown>,
  store: StoryStore,
  activeStory: ActiveStoryForOwnershipGate | null,
  projectRoot: string,
  externalOwnershipClasses?: ExternalCommandOwnershipClasses,
  config?: Pick<ProofOrStopConfig, 'promptEnvelope' | 'browser' | 'cli'>,
  options?: { readOnlyAdmission?: boolean },
): void {
  const storyId = storyIdFromArgs(args, activeStory, { command: cmd, projectRoot });
  const cls = resolveEffectiveOwnershipClass(cmd, args, storyId, externalOwnershipClasses, { config });

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
  // `.proof-or-stop/outside/owner-lease.json` OUTSIDE the story tree. Fail CLOSED on
  // any non-canonical id (the canonical shape is anchored + `[A-Za-z0-9_-]`
  // only, so it can never contain `/`, `\`, or `..`) so NO path is derived and
  // NO lease is written anywhere. Legitimate ids — the `--storyId` arg, an id
  // resolved from an autopilot runId file, or the active story's id — all match
  // the canonical shape (`B-<hex>` etc.), so this never regresses a real story.
  if (!isCanonicalStoryId(storyId)) {
    throw new Error(
      `Refusing to run owner-gated command "${cmd}": storyId ${JSON.stringify(storyId)} is not a ` +
      `valid Proof-or-Stop story id. A story id must match the canonical shape (e.g. B-xxxx) and may ` +
      `not contain a path separator or "..". This is rejected fail-closed before any story ` +
      `directory path is derived (path-traversal guard).`,
    );
  }

  const storyDir = store.storyDirPath(storyId);
  if (!existsSync(storyDir)) return;

  // The handler revalidates and consumes this exact capability only after it
  // has atomically prepared the run-bound subagent_result and checklist write.
  // This pre-handler probe grants no reusable owner lease and performs no
  // mutation, so a failed write remains retryable by the same managed run.
  if (admitsManagedImplementerCompletion(cmd, args, projectRoot, storyId)) return;

  if (options?.readOnlyAdmission) {
    const lease = readOwnerLease(storyDir);
    if (!lease || lease.sessionId === getSessionId()) return;
    const intent = resolveTakeoverIntent(args);
    if (intent === 'forceTakeover' || (intent === 'takeover' && isLeaseStale(lease))) return;
    throw new Error(formatNonOwnerError(lease, {
      storyId,
      command: cmd,
      ownershipClass: cls,
      currentSessionId: getSessionId(),
      currentCwd: process.cwd(),
    }) + reviewerReadRecoveryHint(cmd, args, storyId));
  }

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
        `${storyId} is owned by another Proof-or-Stop session (${lease.sessionId}) whose owner lease is ` +
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
    }) + reviewerReadRecoveryHint(cmd, args, storyId),
  );
}

/** Actionable reader recovery, never a substitute for a scoped/purpose-bound dispatch. */
export function reviewerReadRecoveryHint(cmd: string, args: Record<string, unknown>, storyId?: string | null): string {
  if (cmd === 'verify_codex') return '\nRead-only diagnostics: proof-or-stop codex doctor (does not run verification heartbeats or publish evidence)';
  if (!storyId || !isCanonicalStoryId(storyId)) return '';
  if (cmd === 'scope_freeze_check') return `\nRead-only prerequisites: proof-or-stop init_preflight --storyId=${storyId} (does not generate a freeze proof)`;
  if (cmd === 'acceptance_rollout_report') return `\nRead-only existing report: proof-or-stop acceptance_rollout_report_read --storyId=${storyId} --json (does not generate new rollout evidence)`;
  if (!['agent_prompt', 'dispatch'].includes(cmd)) return '';
  if (['itemId', 'findingId', 'clusterId', 'reviewPurpose', 'inventoryEpochId'].some(key => args[key] !== undefined)) return '';
  const actor = cmd === 'agent_prompt' ? args.role : args.agentType;
  const entry = resolveRegisteredAgentActor(typeof actor === 'string' ? actor : undefined);
  if (!entry || entry.targetCardinality !== 'story-only') return '';
  return `\nRead-only prompt: proof-or-stop agent_prompt --role=${entry.canonicalName} --storyId=${storyId} --readOnly`;
}
