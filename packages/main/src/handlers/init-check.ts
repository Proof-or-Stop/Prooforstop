import { rethrowIntentAmendmentIntegrityError } from '../core/verification-intent-amendment.js';
/**
 * Init Check handler — proof-or-stop init_check_set command shell + metadata lock.
 *
 * The signature/gate primitives (INIT_CHECK_SALT, REQUIRED_INIT_CHECK_AGENTS,
 * normalize/match/results helpers, missingRequiredInitCheckAgents,
 * blockingInitCheckIssues, computeBackgroundHash, computeChecklistHash,
 * signInitCheck, recomputeInitCheckHash) live in core/init-check-gate.ts so that
 * core consumers (machine.ts) can verify the hash and evaluate the INIT_CHECK
 * gate without an upward core→handlers import (B-37e9 F-001 layering fix). This
 * file imports them and re-exports them for backward-compatible callers while
 * keeping the init_check_set handler factory and the metadata-write lock here.
 *
 * For the signature structure and gate semantics of init-check.json (the artifact of the INIT → INIT_CHECK hard gate), see
 * the module comment in core/init-check-gate.ts.
 */

import { execSync } from 'child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { StoryStore } from '../core/store.js';
import type { HandlerContext } from './context.js';
import {
  INIT_CHECK_ISSUE_KINDS,
  PRODUCT_INIT_BLOCKING_ISSUE_KINDS,
  STORY_INIT_BLOCKING_ISSUE_KINDS,
  type ChecklistItem,
  type InitCheckData,
  type InitCheckIssue,
  type VerificationLane,
} from '../core/types.js';
import { autoCommitStoryMetadata } from '../core/auto-commit-metadata.js';
import { currentMaterialHash } from '../core/evidence-freshness.js';
import { resolveGitCwd } from '../core/story-signed-workspace-resolution.js';
import { getSessionId } from '../core/story-owner-lease.js';
import { resolveAgentMutationAuthority } from '../core/agent-dispatch-registry.js';
import {
  INIT_CHECK_SALT,
  REQUIRED_INIT_CHECK_AGENTS,
  INIT_CHECK_FALLBACK_AGENT_SUFFIX,
  normalizeAgentId,
  initCheckAgentMatches,
  initCheckAgentResults,
  initCheckAttestationMode,
  missingRequiredInitCheckAgents,
  blockingInitCheckIssues,
  computeBackgroundHash,
  computeChecklistHash,
  computeInitCheckVerdictHash,
  describeInitCheckSignatureDomain,
  initCheckHashMatches,
  signInitCheck,
  recomputeInitCheckHash,
} from '../core/init-check-gate.js';
import { withMkdirLock } from '../core/mkdir-lock.js';
import { digestCanonicalJson, digestText } from '../core/digest.js';
import { resolveManagedDispatchInvocation } from '../core/managed-host-run.js';

const INIT_CHECK_ISSUE_KIND_SET = new Set<string>(INIT_CHECK_ISSUE_KINDS);
const PRODUCT_INIT_BLOCKING_KIND_SET = new Set<string>(PRODUCT_INIT_BLOCKING_ISSUE_KINDS);
const STORY_INIT_BLOCKING_KIND_SET = new Set<string>(STORY_INIT_BLOCKING_ISSUE_KINDS);

function normalizeSubmittedInitCheckIssue(issue: InitCheckIssue | null | undefined, command: 'init_check_set' | 'init_check_repair'): InitCheckIssue {
  if (!issue || typeof issue.desc !== 'string' || issue.desc.trim().length < 1) {
    throw new Error(`${command}: each issue.desc must be >= 1 character after trim`);
  }
  if (!['critical', 'high', 'medium', 'low'].includes(issue.severity)) {
    throw new Error(`${command}: unsupported issue.severity ${JSON.stringify(issue.severity)}`);
  }
  if (issue.kind !== undefined && !INIT_CHECK_ISSUE_KIND_SET.has(issue.kind)) {
    throw new Error(`${command}: unsupported issue.kind ${JSON.stringify(issue.kind)}`);
  }
  if (issue.id !== undefined && typeof issue.id !== 'string') {
    throw new Error(`${command}: issue.id must be a string when provided`);
  }
  if (issue.requirementRef !== undefined && typeof issue.requirementRef !== 'string') {
    throw new Error(`${command}: issue.requirementRef must be a string when provided`);
  }
  const normalized: InitCheckIssue = { severity: issue.severity, desc: issue.desc };
  if (issue.id !== undefined) normalized.id = issue.id;
  if (issue.kind !== undefined) normalized.kind = issue.kind;
  if (issue.requirementRef !== undefined) normalized.requirementRef = issue.requirementRef;
  return normalized;
}

function verificationIntentIds(item: Pick<ChecklistItem, 'id' | 'verificationIntent'>): string[] {
  const intent = item?.verificationIntent;
  if (!intent || typeof intent !== 'object') return [];
  const lanes: VerificationLane[] = ['happy', 'edge', 'adversarial'];
  const checklistId = typeof item.id === 'string' ? item.id.trim() : '';
  const ids = new Set<string>();
  for (const lane of lanes) {
    const entries = Array.isArray(intent[lane]) ? intent[lane] : [];
    entries.forEach((entry, index) => {
      const explicitId = typeof entry?.id === 'string' ? entry.id.trim() : '';
      if (explicitId) ids.add(explicitId);
      if (checklistId) ids.add(`${checklistId}:${lane}:${index}`);
    });
  }
  return [...ids];
}

function validInitRequirementRefs(checklistItems: ChecklistItem[]): Set<string> {
  const refs = new Set([
    'story:title',
    'story:description',
    'story:type',
    'story:priority',
    'story:riskSignals',
    'background:Trigger Event',
    'background:Key Insights',
    'background:Solution Tradeoffs',
    'background:Conversational Texture',
    'scope-boundary',
    'execution-boundary',
    'required-input:background',
    'required-input:story-metadata',
    'required-input:checklist',
    'required-input:repository-guide',
    'required-input:scope-boundary',
    'required-input:execution-boundary',
  ]);
  for (const item of checklistItems) {
    if (typeof item?.id === 'string' && item.id.trim()) refs.add(`checklist:${item.id.trim()}`);
    for (const id of verificationIntentIds(item)) refs.add(`verification-intent:${id}`);
  }
  return refs;
}

function computeInitReviewerAuthorityInputHash(args: {
  root: string;
  store: StoryStore;
  storyId: string;
  story: ReturnType<StoryStore['readStory']>;
  backgroundHash: string;
  checklistItems: ChecklistItem[];
}): string {
  const guideDigests = ['AGENTS.md', 'CLAUDE.md'].map(path => {
    const absolute = join(args.root, path);
    return { path, digest: existsSync(absolute) ? digestText(readFileSync(absolute, 'utf8')) : 'missing' };
  });
  return digestCanonicalJson({
    story: {
      title: args.story.title,
      description: args.story.description,
      type: args.story.type,
      priority: args.story.priority,
      riskSignals: args.story.riskSignals ?? [],
    },
    backgroundHash: args.backgroundHash,
    checklist: args.checklistItems.map(item => ({
      id: item.id,
      title: item.title,
      context: item.context,
      relatedDocs: item.relatedDocs,
      userSees: item.userSees,
      excludes: item.excludes,
      files: item.files,
      verificationIntent: item.verificationIntent,
    })),
    scopeBoundary: args.store.readScopeBoundary(args.storyId),
    executionBoundary: args.store.readExecutionBoundary(args.storyId),
    repositoryGuides: guideDigests,
  });
}

/**
 * Old-PoS run 28 INIT (run28-29-analysis.md §3.1): the authority input digest of
 * the Story as it is NOW, computed exactly as init_check_set signs it into each
 * reviewer's agentResults row (authorityInputHash). A blocking verdict whose
 * recorded digest differs judged inputs the owner has since changed (priority,
 * userSees, verificationIntent, ... — fields outside the title/context INIT
 * signature), so next relaunches that reviewer as a framework step.
 */
export function currentInitReviewerAuthorityInputHash(root: string, store: StoryStore, storyId: string): string {
  const story = store.readStory(storyId);
  let checklistItems: ChecklistItem[] = [];
  try {
    checklistItems = store.readChecklist(storyId).items;
  } catch (intentIntegrityError) { rethrowIntentAmendmentIntegrityError(intentIntegrityError); }
  return computeInitReviewerAuthorityInputHash({ root, store, storyId, story, backgroundHash: computeBackgroundHash(root, storyId), checklistItems });
}

function normalizeReviewerBlockingAuthority(
  issues: InitCheckIssue[],
  agentId: string,
  checklistItems: ChecklistItem[],
): { issues: InitCheckIssue[]; normalizedCount: number } {
  const allowedKinds = agentId === 'proof-or-stop-product-reviewer'
    ? PRODUCT_INIT_BLOCKING_KIND_SET
    : agentId === 'proof-or-stop-review-story-init'
      ? STORY_INIT_BLOCKING_KIND_SET
      : new Set<string>();
  const validRefs = validInitRequirementRefs(checklistItems);
  let normalizedCount = 0;
  const normalized = issues.map(issue => {
    if ((issue.severity !== 'critical' && issue.severity !== 'high') || issue.kind === 'post_implementation_evidence_missing') {
      return issue;
    }
    const reportedSeverity = issue.severity;
    const kindAllowed = typeof issue.kind === 'string' && allowedKinds.has(issue.kind);
    const requirementRef = typeof issue.requirementRef === 'string' ? issue.requirementRef.trim() : '';
    const refAllowed = requirementRef.length > 0 && validRefs.has(requirementRef);
    if (kindAllowed && refAllowed) return { ...issue, requirementRef };
    normalizedCount += 1;
    return {
      ...issue,
      severity: 'medium' as const,
      reportedSeverity,
      dispositionReason: kindAllowed
        ? 'missing_or_invalid_requirement_ref' as const
        : 'outside_init_reviewer_blocking_authority' as const,
    };
  });
  return { issues: normalized, normalizedCount };
}

function initBlockingIssueKey(issue: InitCheckIssue): string | null {
  if ((issue.severity !== 'critical' && issue.severity !== 'high') || issue.kind === 'post_implementation_evidence_missing') return null;
  const kind = typeof issue.kind === 'string' ? issue.kind.trim() : '';
  const requirementRef = typeof issue.requirementRef === 'string' ? issue.requirementRef.trim() : '';
  return kind && requirementRef ? `${kind}\u0000${requirementRef}` : null;
}

function normalizeUnchangedInputBlockerExpansion(
  issues: InitCheckIssue[],
  previousIssues: InitCheckIssue[] | undefined,
): { issues: InitCheckIssue[]; normalizedCount: number } {
  if (!previousIssues) return { issues, normalizedCount: 0 };
  const previousKeys = new Set(previousIssues.map(initBlockingIssueKey).filter((key): key is string => key !== null));
  const previousCorrectableObservations = previousIssues.filter(issue =>
    (issue.dispositionReason === 'missing_or_invalid_requirement_ref'
      || issue.dispositionReason === 'outside_init_reviewer_blocking_authority')
    && (issue.reportedSeverity === 'critical' || issue.reportedSeverity === 'high'),
  );
  let normalizedCount = 0;
  return {
    issues: issues.map(issue => {
      const key = initBlockingIssueKey(issue);
      const correctsPreviouslyReportedObservation = key !== null && previousCorrectableObservations.some(previous => {
        const previousKind = typeof previous.kind === 'string' ? previous.kind.trim() : '';
        const currentKind = typeof issue.kind === 'string' ? issue.kind.trim() : '';
        return previous.desc.trim() === issue.desc.trim()
          && (!previousKind || previousKind === currentKind)
          && previous.reportedSeverity === issue.severity;
      });
      if (key === null || previousKeys.has(key) || correctsPreviouslyReportedObservation) return issue;
      normalizedCount += 1;
      return {
        ...issue,
        severity: 'medium' as const,
        reportedSeverity: issue.reportedSeverity ?? (issue.severity === 'critical' ? 'critical' as const : 'high' as const),
        dispositionReason: 'unchanged_input_blocker_expansion' as const,
      };
    }),
    normalizedCount,
  };
}

// Backward-compatible re-exports: existing importers (core/machine.ts now reads
// from core directly; story-create.ts / draft-check.ts still import from here).
export {
  INIT_CHECK_SALT,
  REQUIRED_INIT_CHECK_AGENTS,
  INIT_CHECK_FALLBACK_AGENT_SUFFIX,
  normalizeAgentId,
  initCheckAgentMatches,
  initCheckAgentResults,
  initCheckAttestationMode,
  missingRequiredInitCheckAgents,
  blockingInitCheckIssues,
  computeBackgroundHash,
  computeChecklistHash,
  computeInitCheckVerdictHash,
  signInitCheck,
  recomputeInitCheckHash,
};
// The B-8df9 CHK-003 trust helpers (initCheckHashMatches / initCheckSignatureIsValid)
// are deliberately NOT re-exported here: this block exists for callers that predate the
// core/ split, and no such caller can reference a function introduced after it. New code
// imports them from core/init-check-gate.ts directly, which is the layering the module
// comment prescribes.

/** B-95d8 CHK-001: minimum length for a manual fallback attestation reason. */
export const INIT_CHECK_FALLBACK_REASON_MIN = 30;

function withInitCheckLock<T>(store: StoryStore, storyId: string, fn: () => T): T {
  // B-d877 R3 FIX B: relocate out of the git-tracked story dir to the gitignored
  // shared `.proof-or-stop/locks/init-check/<id>-init-check.lock`.
  const lockDir = store.runtimeLockDirPath(storyId, 'init-check', 'init-check');
  return withMkdirLock(lockDir, fn, { label: 'init-check metadata' });
}

/**
 * init_check_set handler factory.
 *
 * Called by the proof-or-stop-review-story-init subagent (CHK-002 template); writes init-check.json.
 * The registry validates mutation authority. A registered PROOF_OR_STOP_AGENT is the
 * authoritative dispatched identity, so payload agent/agentId attribution
 * cannot impersonate a trusted host or a different reviewer lane.
 *
 * Three-layer validation (CLAUDE.md "Handler coding conventions"):
 * - Zod schema: the cli-engine.ts registration side defines the issues array structure + severity enum + desc min(1)
 * - runtime (this handler's entry): re-validates desc.trim().length >= 1 to prevent paths that bypass Zod
 * - gate decision point (CHK-005 implementation): when consuming init-check.json.issues, applies trim validation by the same standard
 */
export function createInitCheckHandlers(ctx: HandlerContext): Record<string, (...args: any[]) => any> {
  const { store, root } = ctx;
  return {
    init_check_set(args: {
      storyId: string;
      issues: InitCheckIssue[];
      agent?: string;
      agentId?: string;
    }): string {
      const authority = resolveAgentMutationAuthority({
        command: 'init_check_set',
        payloadActors: [args.agent, args.agentId],
      });
      if (authority.source !== 'dispatched-env') {
        throw new Error(
          'init_check_set refused: caller-supplied or omitted reviewer identity cannot create independent INIT evidence. '
          + 'Use host_run with managedDispatch=true, or the explicit acknowledged init_check_repair fallback. [delivery_not_acknowledged]',
        );
      }
      const deliveryRunId = resolveManagedDispatchInvocation({
        root,
        storyId: args.storyId,
        agentType: normalizeAgentId(authority.actor),
      });
      return withInitCheckLock(store, args.storyId, () => {
      // 1) story existence check (same approach as scope_check_save)
      let title = '';
      let description = '';
      let reviewRound = '';
      let story: ReturnType<StoryStore['readStory']>;
      try {
        story = store.readStory(args.storyId);
        title = story.title;
        description = story.description;
        reviewRound = story.currentReviewRound || '';
      } catch {
        throw new Error(`Story ${args.storyId} not found`);
      }

      // 2) runtime validation of issues (guards against Zod-bypass paths, aligned with the gate-side trim standard)
      const submittedIssues = (Array.isArray(args.issues) ? args.issues : [])
        .map(issue => normalizeSubmittedInitCheckIssue(issue, 'init_check_set'));

      // 3) compute the three hashes required for the signature
      const backgroundHash = computeBackgroundHash(root, args.storyId);
      let checklistItems: ChecklistItem[] = [];
      let items: Array<{ title: string; context?: string }> = [];
      try {
        const checklist = store.readChecklist(args.storyId);
        checklistItems = checklist.items;
        items = checklistItems.map(i => ({ title: i.title, context: i.context }));
      } catch (intentIntegrityError) { rethrowIntentAmendmentIntegrityError(intentIntegrityError);
        // when checklist.json does not exist, hash is computed against an empty array (consistent with recomputeInitCheckHash behavior)
      }
      const checklistHash = computeChecklistHash(items);
      const authorityInputHash = computeInitReviewerAuthorityInputHash({
        root,
        store,
        storyId: args.storyId,
        story,
        backgroundHash,
        checklistItems,
      });

      // 4) construct InitCheckData (the verdict is part of the signature domain since
      //    B-8df9 CHK-002, so the record must exist BEFORE it can be signed)
      const checkedAt = new Date().toISOString();
      const agentId = normalizeAgentId(authority.actor);
      const normalizedIssues = normalizeReviewerBlockingAuthority(submittedIssues, agentId, checklistItems);
      if (normalizedIssues.normalizedCount > 0) {
        process.stderr.write(
          `⚠ init_check_set ${args.storyId}: normalized ${normalizedIssues.normalizedCount} out-of-authority ` +
          `critical/high issue(s) to advisory; INIT blockers require an actor-allowed kind and an exact requirementRef. ` +
          `[init_reviewer_blocking_authority]\n`,
        );
      }

      // B-8df9 CHK-003 — the carry-forward is the LAST laundering path, and it is closed here.
      //
      // CHK-002 made a hand-edited init-check.json fail its own signature, so the gate now
      // refuses it as init_check_tampered. But this handler COPIES the previous file's
      // agentResults into the record it is about to sign: without the check below, one
      // ordinary reviewer call would take reviewer records nobody ever wrote, carry them
      // into a fresh record, and RE-SIGN them into validity. Tamper once, wait for any
      // legitimate call, and the tampering is laundered into a valid signature.
      //
      // `store.readInitCheck` is an unverified read by decision (see its contract note);
      // this is the point at which reading becomes TRUSTING, so the verification belongs
      // here rather than there. The predecessor is verified against EXACTLY the snapshot
      // this write is signed over — the same backgroundHash / title / description /
      // checklistHash / reviewRound computed above — so the property carried forward is
      // precise: these records were signed by this tool, over the same story content we are
      // signing now. Anything else (hand-edited verdict, a record signed under an older
      // signature domain, a verdict recorded against story content that has since changed,
      // a blank _hash) is UNTRUSTED and is dropped rather than re-signed.
      //
      // Dropping, not throwing: the caller's own verdict is legitimate and is still
      // recorded, and the gate then reports the resulting gap honestly (a missing required
      // reviewer must simply run again). Refusing the write would instead leave the routine
      // case — a reviewer recorded a verdict, the story text was then edited — with no
      // ordinary way forward, only deleting the artifact by hand or spending the audited
      // init_check_repair fallback, both far heavier than the situation warrants.
      const previous = store.readInitCheck(args.storyId);
      const expectedPreviousHash = previous
        ? signInitCheck(
          args.storyId,
          backgroundHash,
          title,
          description,
          checklistHash,
          reviewRound,
          computeInitCheckVerdictHash(previous),
        )
        : '';
      const previousTrusted = initCheckHashMatches(previous, expectedPreviousHash);
      const previousAgentResult = previousTrusted && previous
        ? initCheckAgentResults(previous).find(result => initCheckAgentMatches(result.agentId, agentId) || result.agentId === agentId)
        : undefined;
      const sameAuthorityInputs = previousAgentResult?.authorityInputHash === authorityInputHash;
      const authorityBaselineIssues = sameAuthorityInputs
        ? (previousAgentResult.authorityBaselineIssues ?? previousAgentResult.issues)
        : normalizedIssues.issues;
      const monotonicIssues = normalizeUnchangedInputBlockerExpansion(
        normalizedIssues.issues,
        sameAuthorityInputs ? authorityBaselineIssues : undefined,
      );
      const issues = monotonicIssues.issues;
      if (monotonicIssues.normalizedCount > 0) {
        process.stderr.write(
          `⚠ init_check_set ${args.storyId}: normalized ${monotonicIssues.normalizedCount} new critical/high blocker(s) ` +
          `from an unchanged authoritative INIT input to advisory. Edit the cited INIT requirement before requesting a fresh blocker. ` +
          `[init_reviewer_unchanged_input_expansion]\n`,
        );
      }
      const agentResults = previousTrusted && previous ? initCheckAgentResults(previous).filter(
        result => !initCheckAgentMatches(result.agentId, agentId) && result.agentId !== agentId,
      ) : [];
      const droppedResults = !previousTrusted && previous ? initCheckAgentResults(previous) : [];
      agentResults.push({ agentId, checkedAt, deliveryRunId, authorityInputHash, authorityBaselineIssues, issues });

      // Name the corruption. Silently discarding another reviewer's record would be
      // indistinguishable from that reviewer never having run, which is the confusion this
      // whole gate exists to remove. Advisory text goes to stderr (B-6812) so a caller that
      // pipes stdout still sees it; a short marker also rides the return value because the
      // dropped coverage is a fact about the record just written, not commentary on it.
      let untrustedNotice = '';
      if (previous && !previousTrusted) {
        const dropped = droppedResults.map(r => r.agentId || '<unknown>');
        const storedHash = typeof previous._hash === 'string' ? previous._hash.trim() : '';
        untrustedNotice = `; dropped ${dropped.length} unverifiable prior reviewer record(s): ${dropped.join(', ') || '<none>'}`;
        process.stderr.write(
          `⚠ init_check_set ${args.storyId}: the existing init-check.json does NOT verify against its own signature ` +
          `(stored _hash=${storedHash ? storedHash.slice(0, 12) : '<absent>'}, expected=${expectedPreviousHash.slice(0, 12)}; ` +
          `signed components: ${describeInitCheckSignatureDomain()}).\n` +
          `  Its recorded reviewer results were DROPPED rather than carried into this newly signed record, ` +
          `so tampered or stale coverage cannot be re-signed into validity: ${dropped.join(', ') || '<none>'}\n` +
          `  Only ${agentId}'s result is recorded now; every other required reviewer must run init_check_set again. ` +
          `[init_check_untrusted_carry_forward]\n`,
        );
      }

      const data: InitCheckData = {
        storyId: args.storyId,
        checkedAt,
        reviewRound,
        agentId,
        issues,
        agentResults,
        _hash: '',
      };

      // 5) sign the record being written and persist it. The verdict hash is computed from
      //    `data` itself rather than from copies of its fields, so what is signed and what is
      //    stored cannot drift apart. Shares signInitCheck with recomputeInitCheckHash —
      //    single source of truth for the domain.
      data._hash = signInitCheck(
        args.storyId,
        backgroundHash,
        title,
        description,
        checklistHash,
        reviewRound,
        computeInitCheckVerdictHash(data),
      );
      store.writeInitCheck(args.storyId, data);

      // 6) Return issue counts bucketed by severity. This writer records the
      // reviewer verdict; blocking and phase applicability are decided by the gate.
      let critical = 0, high = 0, medium = 0, low = 0;
      for (const issue of issues) {
        switch (issue.severity) {
          case 'critical': critical++; break;
          case 'high': high++; break;
          case 'medium': medium++; break;
          case 'low': low++; break;
        }
      }
      const missing = missingRequiredInitCheckAgents(data);
      const commitHint = autoCommitStoryMetadata(root, args.storyId, 'init_check_set');
      return `Init check saved for ${args.storyId}: ${issues.length} issues (${critical}/${high}/${medium}/${low}); recorded agents: ${agentResults.map(r => r.agentId || '<unknown>').join(', ')}${normalizedIssues.normalizedCount > 0 ? `; normalized ${normalizedIssues.normalizedCount} out-of-authority blocker(s) to advisory` : ''}${monotonicIssues.normalizedCount > 0 ? `; normalized ${monotonicIssues.normalizedCount} unchanged-input blocker expansion(s) to advisory` : ''}${untrustedNotice}${missing.length > 0 ? `; missing required agents: ${missing.join(', ')}` : ''}${commitHint}`;
      });
    },

    /**
     * init_check_repair — B-95d8 CHK-001 explicit, auditable INIT_CHECK fallback.
     *
     * For environments that cannot spawn the proof-or-stop-review-story-init / proof-or-stop-product-reviewer
     * subagents (no init reviewer available). Produces a SIGNED init-check.json that
     * `canEnterInitCheck` / `getGuardFailureReason` accept — WITHOUT weakening the gate:
     *
     *  - The signature is computed by the SAME `signInitCheck` over the SAME domain
     *    (INIT_CHECK_SIGNATURE_DOMAIN, which since B-8df9 CHK-002 also covers the
     *    reviewer verdict). Editing any signed content afterwards — including the
     *    attested issues — still triggers `init_check_tampered` (the recompute diverges).
     *  - Required-reviewer coverage is satisfied by recording each required agent as
     *    `<required>@fallback`; `initCheckAgentMatches` accepts the `<required>@`
     *    prefix, so missingRequiredInitCheckAgents is empty, while the `@fallback`
     *    suffix + `fallback` block keep the manual attestation mechanically
     *    distinguishable from an independent reviewer run (initCheckAttestationMode).
     *  - Operator-supplied issues still flow through blockingInitCheckIssues: attesting
     *    a high/critical INIT-applicable issue self-blocks (you cannot fallback past a
     *    real blocker). A post_implementation_evidence_missing issue is deferred.
     *
     * NOT default-on: rejects (no file written, no phase change) unless BOTH an
     * explicit `acknowledge: true` AND a `fallbackReason` (>= 30 chars) are supplied.
     * Does NOT check agentId mechanically (EXP-001: caller identity is not mechanically
     * distinguishable in the Bash CLI).
     */
    init_check_repair(args: {
      storyId: string;
      fallbackReason: string;
      acknowledge?: boolean;
      mode?: 'repair' | 'fallback';
      evidenceRefs?: string[];
      issues?: InitCheckIssue[];
      actor?: string;
    }): string {
      // --- Controlled-opt-in preflight (runtime, NOT Zod-only; CLAUDE.md Handler convention) ---
      // These guards MUST run before any read/write so a refusal produces ZERO file
      // write and ZERO phase change. Default-disabled = both ack + reason required.
      if (args.acknowledge !== true) {
        throw new Error(
          'init_check_repair: refused — this fallback bypasses the independent INIT reviewer and is disabled by default. ' +
          'Re-run with explicit acknowledgement: pass acknowledge=true to confirm you are deliberately attesting in lieu of proof-or-stop-review-story-init / proof-or-stop-product-reviewer.',
        );
      }
      const reason = (args.fallbackReason ?? '').trim();
      if (reason.length < INIT_CHECK_FALLBACK_REASON_MIN) {
        throw new Error(
          `init_check_repair: refused — fallbackReason must be >= ${INIT_CHECK_FALLBACK_REASON_MIN} characters (got ${reason.length}). ` +
          'State why the init reviewer cannot run and what you checked in its place; this is recorded as durable audit attestation.',
        );
      }
      const mode = args.mode ?? 'repair';
      if (mode !== 'repair' && mode !== 'fallback') {
        throw new Error(`init_check_repair: mode must be 'repair' or 'fallback' (got ${JSON.stringify(args.mode)})`);
      }
      const evidenceRefs = Array.isArray(args.evidenceRefs)
        ? args.evidenceRefs.map(r => String(r).trim()).filter(r => r.length > 0)
        : [];
      // issues runtime validation mirrors init_check_set (defend the bypass path).
      const issues = (Array.isArray(args.issues) ? args.issues : [])
        .map(issue => normalizeSubmittedInitCheckIssue(issue, 'init_check_repair'));

      return withInitCheckLock(store, args.storyId, () => {
        // 1) story existence (preflight already passed; refusal above wrote nothing).
        let title = '';
        let description = '';
        let reviewRound = '';
        try {
          const story = store.readStory(args.storyId);
          title = story.title;
          description = story.description;
          reviewRound = story.currentReviewRound || '';
        } catch {
          throw new Error(`Story ${args.storyId} not found`);
        }

        // 2) Sign over the SAME domain as init_check_set (single source of truth).
        const backgroundHash = computeBackgroundHash(root, args.storyId);
        let items: Array<{ title: string; context?: string }> = [];
        try {
          const checklist = store.readChecklist(args.storyId);
          items = checklist.items.map(i => ({ title: i.title, context: i.context }));
        } catch (intentIntegrityError) { rethrowIntentAmendmentIntegrityError(intentIntegrityError);
          // checklist absent → empty array hash (matches recomputeInitCheckHash).
        }
        const checklistHash = computeChecklistHash(items);

        // 3) Required-reviewer coverage via `<required>@fallback` records. The bare
        //    operator-supplied issues land on the story-init record (so they flow
        //    through blockingInitCheckIssues); the product-reviewer record is clean.
        const checkedAt = new Date().toISOString();
        const agentResults = REQUIRED_INIT_CHECK_AGENTS.map((required, idx) => ({
          agentId: `${required}@${INIT_CHECK_FALLBACK_AGENT_SUFFIX}`,
          checkedAt,
          issues: idx === 0 ? issues : [],
        }));

        // 4) Audit attestation block (NOT in signature domain; surface + traceability).
        // B-75f0 CHK-002: a real storyId (args.storyId) + store are in scope, so
        // resolve the audit git cwd with the id-keyed resolveGitCwd. On a
        // wrapper-root layout it is the real gitRoot subdir so the headHash /
        // git-identity probes read the actual repo; on a plain repo (or when no
        // gitRoot resolves) it falls back to root verbatim (byte-identical). The
        // omit-on-failure behavior (try/catch leaving headHash/actor unset) is
        // preserved on a non-git or unavailable cwd.
        const auditGitCwd = resolveGitCwd({ store, storyId: args.storyId, metadataRoot: root, projectRoot: root });
        let headHash: string | undefined;
        try {
          headHash = execSync('git rev-parse HEAD', { cwd: auditGitCwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim() || undefined;
        } catch { /* PROBE: non-git or unavailable, omit headHash */ }
        const materialHash = currentMaterialHash(root) || undefined;
        let actor = (args.actor ?? '').trim();
        if (!actor) {
          try {
            actor = execSync('git config user.name', { cwd: auditGitCwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
          } catch { /* PROBE: no git identity, leave actor empty */ }
        }
        let session: string | undefined;
        try {
          session = getSessionId() || undefined;
        } catch { /* PROBE: session id unavailable */ }

        const data: InitCheckData = {
          storyId: args.storyId,
          checkedAt,
          reviewRound,
          agentId: `${REQUIRED_INIT_CHECK_AGENTS[0]}@${INIT_CHECK_FALLBACK_AGENT_SUFFIX}`,
          issues,
          agentResults,
          fallback: {
            mode,
            reason,
            ...(evidenceRefs.length > 0 ? { evidenceRefs } : {}),
            ...(actor ? { actor } : {}),
            ...(session ? { session } : {}),
            attestedAt: checkedAt,
            ...(headHash ? { headHash } : {}),
            ...(materialHash ? { materialHash } : {}),
          },
          _hash: '',
        };
        // Sign the record being written: the verdict (agentResults + issues) is part of the
        // domain since B-8df9 CHK-002, so signing must follow construction. The `fallback`
        // block stays OUT of the domain (audit/surface metadata, unchanged by this story).
        data._hash = signInitCheck(
          args.storyId,
          backgroundHash,
          title,
          description,
          checklistHash,
          reviewRound,
          computeInitCheckVerdictHash(data),
        );
        store.writeInitCheck(args.storyId, data);

        // 5) Durable audit event in the process timeline (advisory; init-check.json
        //    is the signed truth, this is the activity-log projection).
        try {
          store.appendProcessEvent(args.storyId, {
            type: 'init_check_fallback',
            mode,
            ...(actor ? { actor } : {}),
            ...(session ? { session } : {}),
            ...(headHash ? { headHash } : {}),
          });
        } catch (e) {
          console.warn(`[process-events] append failed for ${args.storyId}:`, (e as Error).message);
        }

        const blockers = blockingInitCheckIssues(data);
        const commitHint = autoCommitStoryMetadata(root, args.storyId, 'init_check_repair');
        const auditLine = `⚠ fallback has been recorded in audit events (actor=${actor || '<unknown>'}, mode=${mode}${session ? `, session=${session}` : ''}), signature verification was not bypassed`;
        const boundaryLine = `⚠ Fallback only repairs INIT_CHECK; it does not authorize implementation and does not replace later PLAN/DEV/REVIEW/TEST reviewers.`;
        if (blockers.length > 0) {
          // Operator attested blocking issues → gate still blocks. Be explicit.
          const lines = blockers.slice(0, 8).map(({ issue }) => `  - ${issue.severity} ${issue.id ? `${issue.id} ` : ''}${issue.desc}`);
          return `✓ init-check.json generated (fallback channel, signature domain unchanged)\n${auditLine}\n${boundaryLine}\n⚠ but high/critical issues were recorded, the INIT_CHECK gate will still block. Please fix them and rerun first:\n${lines.join('\n')}${commitHint}`;
        }
        return `✓ init-check.json generated (fallback channel, signature domain unchanged)\n${auditLine}\n${boundaryLine}\n→ You can now run proof-or-stop story_advance --storyId=${args.storyId} --phase=INIT_CHECK${commitHint}`;
      });
    },
  };
}
