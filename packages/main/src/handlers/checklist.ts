
import { existsSync } from 'fs';
import { join } from 'path';
import type { HandlerContext } from './context.js';
import { assertCwdInWorktree } from './context.js';
import { execSync } from 'child_process';
import { checkEvidenceFreshnessForGit, currentMaterialHash, currentStoryFilesHash } from '../core/evidence-freshness.js';
import { resolveGitCwd } from '../core/story-signed-workspace-resolution.js';
import type { ChecklistData, ChecklistStatus, StoryInfo, VerificationEvidence, VerificationIntent, VerificationIntentType, VerificationLane } from '../core/types.js';
import { buildVerificationCoverage, makeEvidence, VERIFICATION_LANES } from '../core/verification.js';
import { autoCommitStoryMetadata } from '../core/auto-commit-metadata.js';
import { withMkdirLock } from '../core/mkdir-lock.js';
import { effectiveExcludedKeywords, normalizeBoundaryArray, scanExcludedKeywordHits } from '../core/scope-anti-expansion.js';
import type { ScopeFreezeTextSource } from '../core/types.js';

const INIT_REVIEWER_CHECKLIST_MUTATION_BLOCKED_AGENTS = new Set([
  'lattice-review-story-init',
  'product-reviewer',
]);

type VerificationEvidenceKindInput = VerificationEvidence['kind'] | 'cli' | 'logic';
type VerificationEvidenceInput = Omit<VerificationEvidence, 'kind'> & { kind: VerificationEvidenceKindInput };
type ChecklistGetArgs = { storyId: string; slim?: boolean; fields?: string[] };

function pickTopLevelFields<T extends Record<string, unknown>>(value: T, fields?: string[]): Partial<T> {
  const requested = (fields || []).map(field => field.trim()).filter(Boolean);
  if (requested.length === 0) return value;
  const selected: Partial<T> = {};
  for (const field of requested) {
    if (Object.prototype.hasOwnProperty.call(value, field)) {
      selected[field as keyof T] = value[field as keyof T];
    }
  }
  return selected;
}

function verificationIntentCounts(intent: VerificationIntent | undefined): Record<VerificationLane, number> & { total: number; must: number } {
  let total = 0;
  let must = 0;
  const counts = {
    happy: intent?.happy?.length ?? 0,
    edge: intent?.edge?.length ?? 0,
    adversarial: intent?.adversarial?.length ?? 0,
  };
  for (const lane of VERIFICATION_LANES) {
    total += counts[lane];
    must += (intent?.[lane] || []).filter(item => item.priority === 'must').length;
  }
  return { ...counts, total, must };
}

function verificationEvidenceCounts(evidence: VerificationEvidence[] | undefined): {
  total: number;
  passing: number;
  failing: number;
  waivers: number;
} {
  const list = evidence || [];
  return {
    total: list.length,
    passing: list.filter(item => item.kind !== 'waiver' && item.result !== 'fail').length,
    failing: list.filter(item => item.result === 'fail').length,
    waivers: list.filter(item => item.kind === 'waiver').length,
  };
}

export function summarizeChecklist(cl: ChecklistData): {
  total: number;
  done: number;
  inProgress: number;
  pending: number;
} {
  return {
    total: cl.items.length,
    done: cl.items.filter(item => item.status === 'done').length,
    inProgress: cl.items.filter(item => item.status === 'in_progress').length,
    pending: cl.items.filter(item => item.status === 'pending').length,
  };
}

export function renderSlimChecklist(storyId: string, cl: ChecklistData): Record<string, unknown> {
  return {
    storyId,
    counts: summarizeChecklist(cl),
    items: cl.items.map(item => ({
      id: item.id,
      title: item.title,
      status: item.status,
      verificationIntent: verificationIntentCounts(item.verificationIntent),
      verificationEvidence: verificationEvidenceCounts(item.verificationEvidence),
    })),
  };
}

/**
 * B-6812 CHK-001: delegates to the shared `withMkdirLock` primitive. Lock path
 * stays `<story>/checklist.lock`; external behavior is unchanged.
 */
function withChecklistLock<T>(ctx: HandlerContext, storyId: string, fn: () => T): T {
  const lockDir = ctx.store.storyFilePath(storyId, 'checklist.lock');
  return withMkdirLock(lockDir, fn, { label: 'checklist metadata' });
}

/**
 * B-45ed CHK-008: Given a storyId, return the relative path if background.md exists, otherwise return null.
 */
function resolveBackgroundPath(root: string, store: HandlerContext['store'], storyId: string): string | null {
  const rel = `${store.storyDirRel()}/${storyId}/background.md`;
  const abs = join(root, rel);
  return existsSync(abs) ? rel : null;
}

function assertChecklistMutationCwd(store: HandlerContext['store'], storyId: string): StoryInfo {
  const story = store.readStory(storyId);
  assertCwdInWorktree(store, storyId);
  return story;
}

function checklistActorFrom(args: { agent?: string; actor?: string }): string {
  const explicit = args.agent?.trim() || args.actor?.trim();
  if (explicit) return explicit;
  return process.env.LATTICE_AGENT?.trim() || process.env.USER?.trim() || 'main-agent';
}

function isInitReviewerChecklistActor(actor: string): boolean {
  return INIT_REVIEWER_CHECKLIST_MUTATION_BLOCKED_AGENTS.has(actor.trim());
}

function assertInitReviewerChecklistMutationAllowed(args: {
  story: StoryInfo;
  command: 'checklist_add' | 'checklist_update';
  actor: string;
  mutatesDefinition: boolean;
}): void {
  if (args.story.phase !== 'INIT') return;
  if (!args.mutatesDefinition) return;
  if (!isInitReviewerChecklistActor(args.actor)) return;
  throw new Error(
    `${args.command} refused: INIT reviewer lane "${args.actor}" cannot directly modify checklist title/context/excludes in INIT. [init_reviewer_checklist_mutation_blocked]\n` +
    `→ Record requested expansion with scope_extension_proposal; the main agent may then accept/reject via scope_extension_decide and rerun scope_freeze_check.`,
  );
}

function assertChecklistScopeChangeAllowed(
  store: HandlerContext['store'],
  storyId: string,
  change: { itemId?: string; title?: string; context?: string; excludes?: string[] },
): void {
  const explicitExcludes = normalizeBoundaryArray(change.excludes);
  let scopeBoundary;
  try {
    scopeBoundary = store.readScopeBoundary(storyId);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Cannot update checklist: scope-boundary.json could not be read. [scope_boundary_unreadable]\n  - ${msg}`);
  }

  const keywords = normalizeBoundaryArray([
    ...effectiveExcludedKeywords(scopeBoundary, scopeBoundary?.mode ?? 'custom'),
    ...explicitExcludes,
  ]);
  if (keywords.length === 0) return;

  const sources: ScopeFreezeTextSource[] = [];
  if (change.title !== undefined) {
    sources.push({ source: 'checklist.title', text: change.title, ...(change.itemId ? { itemId: change.itemId } : {}) });
  }
  if (change.context !== undefined) {
    sources.push({ source: 'checklist.context', text: change.context, ...(change.itemId ? { itemId: change.itemId } : {}) });
  }
  for (const excluded of explicitExcludes) {
    sources.push({ source: 'checklist.excludes', text: excluded, ...(change.itemId ? { itemId: change.itemId } : {}), excluded: true });
  }
  if (sources.length === 0) return;

  const hit = scanExcludedKeywordHits(sources, keywords).find(item => !item.excluded);
  if (!hit) return;
  const itemRef = hit.itemId ? ` (${hit.itemId})` : '';
  throw new Error(
    `checklist change includes excluded scope keyword "${hit.keyword}" in ${hit.source}${itemRef}. [excluded_keyword_in_checklist]\n` +
    `→ Keep excluded directions in excludes, or route expansion through scope_extension_proposal and explicit scope_extension_decide.`,
  );
}

export function assertChecklistAddAllowed(
  store: HandlerContext['store'],
  args: {
    storyId: string;
    title: string;
    context?: string;
    excludes?: string[];
    reason?: string;
    agent?: string;
    actor?: string;
  },
): StoryInfo {
  if (!args.title) throw new Error('title is required');

  const story = assertChecklistMutationCwd(store, args.storyId);
  if (story.phase === 'PLAN' && (!args.reason || args.reason.trim().length < 10)) {
    throw new Error('checklist_add in PLAN phase must provide reason ≥ 10 characters as a replan/scope audit signal, to prevent bypassing title/context freeze');
  }
  assertInitReviewerChecklistMutationAllowed({
    story,
    command: 'checklist_add',
    actor: checklistActorFrom(args),
    mutatesDefinition: true,
  });
  assertChecklistScopeChangeAllowed(store, args.storyId, {
    title: args.title,
    context: args.context,
    excludes: args.excludes,
  });
  return story;
}

/**
 * B-75f0 CHK-001: gitCwd is the RESOLVED git invocation cwd (wrapper-root aware);
 * metadataRoot is the config-load root for the storyDir-aware metadata exclusion.
 * Callers thread resolveGitCwd(...) at the handler boundary (where store +
 * args.storyId live). On a wrapper-root layout (metadataRoot != gitRoot) the bare
 * metadataRoot is not a git repo, so the old `git rev-parse HEAD` / git ls-tree
 * from there errored and BOTH freshness hashes were silently omitted. For a plain
 * repo (metadataRoot == gitRoot) resolveGitCwd returns root and metadataRoot
 * defaults to gitCwd, so the hashes are byte-identical to before.
 */
function evidenceHashes(gitCwd: string, metadataRoot: string = gitCwd): { headHash?: string; materialHash?: string; storyFilesHash?: string } {
  let headHash = '';
  try {
    headHash = execSync('git rev-parse HEAD', { cwd: gitCwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  } catch { /* PROBE: non-git or unavailable, omit freshness hash */ }
  const materialHash = currentMaterialHash(gitCwd, 'HEAD', metadataRoot);
  const storyFilesHash = currentStoryFilesHash(gitCwd, 'HEAD', metadataRoot);
  return {
    ...(headHash ? { headHash } : {}),
    ...(materialHash ? { materialHash } : {}),
    ...(storyFilesHash ? { storyFilesHash } : {}),
  };
}

function normalizeEvidenceKind(kind: VerificationEvidenceKindInput): VerificationEvidence['kind'] {
  if (kind === 'cli') return 'manual_transcript';
  if (kind === 'logic') return 'logic_test';
  return kind;
}

function normalizeEvidence(gitCwd: string, metadataRoot: string, input: VerificationEvidenceInput): VerificationEvidence {
  const hashes = evidenceHashes(gitCwd, metadataRoot);
  const kind = normalizeEvidenceKind(input.kind);
  return makeEvidence({
    intentRef: input.intentRef,
    kind,
    ...(input.verdict ? { verdict: input.verdict } : {}),
    ...(input.waiverType ? { waiverType: input.waiverType } : {}),
    ...(input.file ? { file: input.file } : {}),
    ...(input.command ? { command: input.command } : {}),
    ...(input.result ? { result: input.result } : {}),
    note: input.note.trim(),
    headHash: input.headHash || hashes.headHash,
    materialHash: input.materialHash || hashes.materialHash,
    storyFilesHash: input.storyFilesHash || hashes.storyFilesHash,
    ...(input.attestation ? { attestation: input.attestation } : {}),
  });
}

/**
 * B-4e06 CHK-001: canonical structured intent ref — `CHK-001:happy:0`. Mirrors
 * verification.ts intentRef(). A ref scoped to an item
 * (`${item.id}:`) that does NOT match this is malformed → fail-closed.
 */
const STRUCTURED_INTENT_REF = /^(CHK-\d+):(happy|edge|adversarial):(\d+)$/;

/** Phases where verification_intent_repair is refused: pre-DEV scaffold + terminal/immutable. */
const INTENT_REPAIR_REFUSED_PHASES = new Set(['INIT', 'INIT_CHECK', 'DONE', 'DISCARDED', 'META']);

/** Map a recorded evidence kind to the closest verificationIntent type (lossy but stable). */
function mapEvidenceKindToIntentType(kind: VerificationEvidence['kind']): VerificationIntentType {
  switch (kind) {
    case 'logic_test': return 'logic';
    case 'integration_test': return 'cli';
    case 'browser_test': return 'browser';
    case 'manual_transcript': return 'manual';
    case 'docs_check': return 'docs';
    default: return 'cli';
  }
}

/** Reconstruct a human intent description from the evidence that proves it. */
function deriveIntentDesc(ev: VerificationEvidence): string {
  const source = (ev.note && ev.note.trim()) || ev.command || ev.file || ev.kind;
  const base = source.length > 140 ? `${source.slice(0, 137)}...` : source;
  return `Reconstructed from ${ev.kind} evidence: ${base}`;
}

/** PASSING evidence only seeds intent: never a waiver, never an explicit fail. */
function isPassingEvidence(ev: VerificationEvidence): boolean {
  return ev.kind !== 'waiver' && ev.result !== 'fail';
}

/**
 * B-4e06 CHK-001: pure reconstruction. For every checklist item, fill the
 * MISSING verificationIntent lane slot that a passing, item-scoped, structured
 * evidence ref points at — never overwriting an authored intent, synthesizing
 * priority='should'. Mutates `cl` in place and returns the list of filled
 * `itemId:lane:index (type)` refs. Throws on a malformed item-scoped ref
 * (fail-closed). No I/O, so it is unit-testable without a git worktree.
 */
export function reconstructMissingIntentsFromEvidence(cl: ChecklistData): string[] {
  const filled: string[] = [];
  for (const item of cl.items) {
    for (const ev of item.verificationEvidence || []) {
      // Only refs scoped to THIS item; the `${item.id}:` prefix (with the colon)
      // guarantees the regex capture group m[1] === item.id, so no separate check.
      if (!ev.intentRef.startsWith(`${item.id}:`)) continue; // custom/foreign refs ignored
      const m = STRUCTURED_INTENT_REF.exec(ev.intentRef);
      if (!m) {
        throw new Error(`verification_intent_repair: malformed intentRef '${ev.intentRef}' on ${item.id} — expected CHK-N:(happy|edge|adversarial):N. Fix the evidence ref before repair.`);
      }
      if (!isPassingEvidence(ev)) continue; // never synthesize from failing/waiver evidence
      const lane = m[2] as VerificationLane;
      const index = Number(m[3]);
      const vi: VerificationIntent = item.verificationIntent || { happy: [], edge: [], adversarial: [] };
      for (const l of VERIFICATION_LANES) if (!vi[l]) vi[l] = [];
      if (vi[lane][index]) continue;        // never overwrite authored intent
      while (vi[lane].length < index) {
        vi[lane].push({ desc: 'Reconstructed placeholder (no evidence at this index)', type: 'logic', priority: 'nice' });
      }
      vi[lane][index] = {
        desc: deriveIntentDesc(ev),
        type: mapEvidenceKindToIntentType(ev.kind),
        priority: 'should',
      };
      item.verificationIntent = vi;
      filled.push(`${item.id}:${lane}:${index} (${vi[lane][index].type})`);
    }
  }
  return filled;
}

export function createChecklistHandlers(ctx: HandlerContext) {
  const { store, root } = ctx;
  // B-75f0 CHK-001: resolve the authoritative git cwd for a story-scoped command.
  // Every verification-evidence handler here has args.storyId in scope, so it can
  // route freshness git probes through the single resolveGitCwd choke-point. On a
  // wrapper-root layout this returns the configured gitRoot subdir; on a plain
  // repo it returns `root` (byte-identical fallback). metadataRoot stays `root`
  // so the storyDir-aware metadata exclusion loads config from the right place.
  const resolveStoryGitCwd = (storyId: string): string =>
    resolveGitCwd({ store, storyId, metadataRoot: root, projectRoot: root });
  return {
    checklist_get(args: ChecklistGetArgs) {
      const full = store.readChecklist(args.storyId);
      if (!args.slim && !args.fields) return full;
      const result = args.slim ? renderSlimChecklist(args.storyId, full) : full as unknown as Record<string, unknown>;
      return pickTopLevelFields(result, args.fields);
    },

    checklist_add(args: {
      storyId: string;
      title: string;
      context?: string;
      relatedDocs?: string[];
      userSees?: string;
      excludes?: string[];
      files?: { modify: string[]; create: string[]; test: string[] };
      verificationIntent?: VerificationIntent;
      reason?: string;
      agent?: string;
      actor?: string;
    }): string {
      const story = assertChecklistAddAllowed(store, args);

      return withChecklistLock(ctx, args.storyId, () => {
      const cl = store.readChecklist(args.storyId);

      // Find the largest CHK number from existing items and allocate the next one
      let maxNum = 0;
      for (const item of cl.items) {
        const m = item.id.match(/^CHK-(\d+)$/);
        if (m) {
          const n = parseInt(m[1], 10);
          if (n > maxNum) maxNum = n;
        }
      }
      const nextId = `CHK-${String(maxNum + 1).padStart(3, '0')}`;

      // B-45ed CHK-008: When relatedDocs is not provided / is an empty array, automatically inject the background.md path (if the file exists).
      // If the caller has explicitly provided a non-empty relatedDocs, respect that choice and do not auto-insert.
      let effectiveRelatedDocs: string[] | undefined = args.relatedDocs;
      if (!effectiveRelatedDocs || effectiveRelatedDocs.length === 0) {
        const bgRel = resolveBackgroundPath(root, store, args.storyId);
        if (bgRel) {
          effectiveRelatedDocs = [bgRel];
        } else if (args.relatedDocs !== undefined) {
          // User explicitly passed an empty array and background.md does not exist → keep as empty array
          effectiveRelatedDocs = args.relatedDocs;
        } else {
          // Not passed && no background → do not write the relatedDocs field
          effectiveRelatedDocs = undefined;
        }
      }

      cl.items.push({
        id: nextId,
        title: args.title,
        context: args.context,
        ...(effectiveRelatedDocs !== undefined ? { relatedDocs: effectiveRelatedDocs } : {}),
        ...(args.userSees ? { userSees: args.userSees } : {}),
        ...(args.excludes !== undefined ? { excludes: args.excludes } : {}),
        ...(args.files !== undefined ? { files: {
          modify: args.files.modify ?? [],
          create: args.files.create ?? [],
          test: args.files.test ?? [],
        } } : {}),
        ...(args.verificationIntent !== undefined ? { verificationIntent: args.verificationIntent } : {}),
        status: 'pending',
        startTime: null,
        endTime: null,
      });

      if (story.phase === 'PLAN') {
        if (!cl.auditLog) cl.auditLog = [];
        cl.auditLog.push({
          timestamp: new Date().toISOString(),
          phase: story.phase,
          itemId: nextId,
          action: 'add',
          from: 'pending' as ChecklistStatus,
          to: 'pending' as ChecklistStatus,
          reason: args.reason!.trim(),
          addedTitle: args.title,
          addedContext: args.context || '',
        });
      }

      store.writeChecklist(args.storyId, cl);
      try {
        store.appendProcessEvent(args.storyId, {
          type: 'plan_updated',
          action: 'add',
          itemId: nextId,
          phase: story.phase,
        });
      } catch (e) {
        console.warn(`[process-events] append failed for ${args.storyId}:`, (e as Error).message);
      }
      return `Checklist item ${nextId} added to ${args.storyId}`;
      });
    },

    checklist_remove(args: {
      storyId: string;
      itemId: string;
      disposition: 'accept' | 'reject' | 'partial';
      justification: string;
    }): string {
      // Justification must be given
      if (!args.justification || args.justification.trim().length < 10) {
        throw new Error('justification must be ≥ 10 characters, explaining why this checklist item is being removed');
      }
      const validDispositions = ['accept', 'reject', 'partial'];
      if (!validDispositions.includes(args.disposition)) {
        throw new Error(`disposition must be one of accept/reject/partial, received: ${args.disposition}`);
      }

      return withChecklistLock(ctx, args.storyId, () => {
      const cl = store.readChecklist(args.storyId);
      const idx = cl.items.findIndex(i => i.id === args.itemId);
      if (idx === -1) throw new Error(`Checklist item ${args.itemId} not found`);

      const item = cl.items[idx];
      if (item.status === 'done') {
        throw new Error(`Cannot remove ${args.itemId}: already done. Re-open first if needed.`);
      }

      // Only the INIT phase allows removal. From INIT_CHECK onward, title/context is frozen;
      // if PLAN still allowed remove+add, it would be equivalent to bypassing the freeze gate of checklist_update.
      const story = assertChecklistMutationCwd(store, args.storyId);
      const allowedPhases = ['INIT'];
      if (!allowedPhases.includes(story.phase)) {
        throw new Error(`${story.phase} phase does not allow removing checklist items; from INIT_CHECK onward checklist title/context is frozen, to prevent remove+add bypass. New scope can only be added via checklist_add, the original item must remain for gate review`);
      }

      const removed = cl.items.splice(idx, 1)[0];

      // Audit log: record the complete removed item info + disposition, written automatically
      if (!cl.auditLog) cl.auditLog = [];
      cl.auditLog.push({
        timestamp: new Date().toISOString(),
        phase: story.phase,
        itemId: args.itemId,
        action: 'delete',
        from: removed.status,
        to: 'pending' as const,
        reason: args.justification.trim(),
        removedTitle: removed.title,
        removedContext: removed.context || '',
        removedUserSees: removed.userSees || '',
        disposition: args.disposition,
        justification: args.justification.trim(),
        disposedAt: new Date().toISOString(),
      });

      store.writeChecklist(args.storyId, cl);
      try {
        store.appendProcessEvent(args.storyId, {
          type: 'plan_updated',
          action: 'remove',
          itemId: args.itemId,
          phase: story.phase,
        });
      } catch (e) {
        console.warn(`[process-events] append failed for ${args.storyId}:`, (e as Error).message);
      }
      return `Checklist item ${args.itemId} ("${removed.title}") removed from ${args.storyId}\n` +
        `  disposition: ${args.disposition}\n` +
        `  justification: ${args.justification.trim()}\n` +
        `⚠ scope change recorded, story_review will display this removal for reviewer audit`;
      });
    },

    checklist_update(args: {
      storyId: string;
      itemId: string;
      status?: 'pending' | 'in_progress' | 'done';
      title?: string;
      context?: string;
      relatedDocs?: string[];
      userSees?: string;
      excludes?: string[];
      files?: { modify: string[]; create: string[]; test: string[] };
      verificationIntent?: VerificationIntent;
      verificationEvidence?: VerificationEvidenceInput[];
      reason?: string;
      agent?: string;
      actor?: string;
      success?: boolean;
    }): string {
      if (!args.status && args.title === undefined && args.context === undefined && args.relatedDocs === undefined && args.userSees === undefined && args.excludes === undefined && args.files === undefined && args.verificationIntent === undefined && args.verificationEvidence === undefined) {
        throw new Error('At least one of status/title/context/relatedDocs/userSees/excludes/files/verificationIntent/verificationEvidence must be provided');
      }

      return withChecklistLock(ctx, args.storyId, () => {
      // Truth source protection: DEV and later phases forbid modifying the fundamental information of checklist
      // checklist is the truth source; executors (main agent / subagent) cannot tamper with the requirement definition during execution
      //
      // B-9d95 CHK-008: userSees is split out from the protection scope of title/context and gated separately
      //   - title/context are protected from INIT_CHECK onward (PLAN modifications are rejected, requires story_advance back to INIT_CHECK)
      //   - userSees is a PLAN artifact (see CLAUDE.md checklist conventions), allowed to be added/modified during the PLAN phase,
      //     frozen from DEV onward (the executor must not tamper with the acceptance description during implementation)
      const story = assertChecklistMutationCwd(store, args.storyId);
      const titleContextFields = ['title', 'context'] as const;
      const titleContextProtectedPhases = ['INIT_CHECK', 'PLAN', 'DEV', 'REVIEW', 'TEST', 'DONE'];
      const userSeesProtectedPhases = ['DEV', 'REVIEW', 'TEST', 'DONE'];
      const verificationIntentProtectedPhases = ['DEV', 'REVIEW', 'TEST', 'DONE'];

      const attemptedTitleContext = titleContextFields.filter(f => args[f] !== undefined);
      assertInitReviewerChecklistMutationAllowed({
        story,
        command: 'checklist_update',
        actor: checklistActorFrom(args),
        mutatesDefinition: attemptedTitleContext.length > 0 || args.excludes !== undefined,
      });
      if (attemptedTitleContext.length > 0 && titleContextProtectedPhases.includes(story.phase)) {
        throw new Error(
          `${attemptedTitleContext.join('/')} of ${args.itemId} cannot be modified during the ${story.phase} phase. ` +
          `checklist is the source of truth; from INIT_CHECK onward the executor must not tamper with requirement definitions. ` +
          `To change title/context, first story_advance back to INIT_CHECK`
        );
      }

      if (args.userSees !== undefined && userSeesProtectedPhases.includes(story.phase)) {
        throw new Error(
          `userSees of ${args.itemId} cannot be modified during the ${story.phase} phase. ` +
          `userSees is frozen at the end of PLAN; from DEV onward the executor must not change the acceptance description. ` +
          `To adjust, use finding_add to request going back to PLAN`
        );
      }
      if (args.verificationIntent !== undefined && verificationIntentProtectedPhases.includes(story.phase)) {
        throw new Error(
          `verificationIntent of ${args.itemId} cannot be modified during the ${story.phase} phase. ` +
          `verificationIntent is the source of truth for test intent in the PLAN phase; after DEV you can only append verificationEvidence or use a finding to request going back to PLAN.`
        );
      }

      const cl = store.readChecklist(args.storyId);
      const item = cl.items.find(i => i.id === args.itemId);
      if (!item) throw new Error(`Checklist item ${args.itemId} not found`);
      assertChecklistScopeChangeAllowed(store, args.storyId, {
        title: args.title ?? (args.excludes !== undefined ? item.title : undefined),
        context: args.context ?? (args.excludes !== undefined ? item.context : undefined),
        excludes: args.excludes ?? item.excludes,
        itemId: args.itemId,
      });

      const results: string[] = [];
      const now = new Date().toISOString();
      const oldStatus = item.status;

      if (args.title !== undefined) {
        item.title = args.title;
        results.push(`title updated`);
      }
      if (args.context !== undefined) {
        item.context = args.context;
        results.push(`context updated`);
      }
      if (args.relatedDocs !== undefined) {
        item.relatedDocs = args.relatedDocs;
        results.push(`relatedDocs updated (${args.relatedDocs.length})`);
      }
      if (args.userSees !== undefined) {
        item.userSees = args.userSees;
        results.push(`userSees updated`);
      }
      if (args.excludes !== undefined) {
        item.excludes = args.excludes;
        results.push(`excludes updated (${args.excludes.length})`);
      }
      if (args.files !== undefined) {
        item.files = {
          modify: args.files.modify ?? [],
          create: args.files.create ?? [],
          test: args.files.test ?? [],
        };
        results.push(`files updated (modify:${item.files.modify.length} create:${item.files.create.length} test:${item.files.test.length})`);
      }
      if (args.verificationIntent !== undefined) {
        item.verificationIntent = args.verificationIntent;
        results.push(`verificationIntent updated`);
      }
      if (args.verificationEvidence !== undefined) {
        item.verificationEvidence = args.verificationEvidence.map(ev => normalizeEvidence(resolveStoryGitCwd(args.storyId), root, ev));
        results.push(`verificationEvidence updated (${args.verificationEvidence.length})`);
      }

      if (args.status) {
        item.status = args.status;
        if (args.status === 'in_progress' && !item.startTime) {
          item.startTime = now;
        }
        if (args.status === 'done') {
          item.endTime = now;
        }

        // Modification operations write audit logs (new pending→pending does not count as a modification)
        if (oldStatus !== args.status && args.reason) {
          const story = store.readStory(args.storyId);
          if (!cl.auditLog) cl.auditLog = [];
          cl.auditLog.push({
            timestamp: now,
            phase: story.phase,
            itemId: args.itemId,
            action: 'update',
            from: oldStatus,
            to: args.status,
            reason: args.reason,
            ...(args.agent ? { agent: args.agent } : {}),
          });
        }
        results.push(`status → ${args.status}`);
      }

      store.writeChecklist(args.storyId, cl);

      // B-3511: append process events on status transitions
      if (args.status && oldStatus !== args.status) {
        try {
          if (args.status === 'in_progress') {
            store.appendProcessEvent(args.storyId, {
              type: 'dispatch',
              checklistId: args.itemId,
              ...(args.agent ? { agent: args.agent } : {}),
            });
          } else if (args.status === 'done') {
            store.appendProcessEvent(args.storyId, {
              type: 'subagent_result',
              checklistId: args.itemId,
              success: args.success !== false,
            });
          }
        } catch (e) {
          console.warn(`[process-events] append failed for ${args.storyId}:`, (e as Error).message);
        }
      }

      const commitHint = autoCommitStoryMetadata(root, args.storyId, 'checklist_update');

      // B-95d8 CHK-002: post-write reload reminder.
      // Re-read the FINAL persisted state (read-after-write) so a long session does
      // not keep trusting a stale pre-write snapshot (e.g. "still in_progress" when
      // the write already flipped it to done). The reminder goes to STDERR, never
      // stdout, following the B-6812 advisory-to-stderr precedent: stdout stays the
      // pure conclusion so `lattice checklist_update | tail` pipelines are unaffected.
      try {
        const persisted = store.readChecklist(args.storyId).items.find(i => i.id === args.itemId);
        const persistedStatus = persisted ? persisted.status : '<unknown>';
        process.stderr.write(
          `↻ Written and persistence confirmed: ${args.itemId} current status=${persistedStatus}. ` +
          `For long sessions please reload (lattice checklist_get / session_brief) before relying on the snapshot.\n`,
        );
      } catch (e) {
        // Reminder is advisory only — a read-back failure must never change the
        // write result or the stdout conclusion.
        console.warn(`[checklist_update] post-write reload reminder skipped for ${args.storyId}: ${(e as Error).message}`);
      }

      // CHK-003: when pending/in_progress → done and the item has relatedDocs, hint the related document list
      // B-45ed CHK-008: the done hint list uniformly includes background.md (if it exists and is not in item.relatedDocs), ensuring downstream sync alignment
      const transitionedToDone = args.status === 'done' && oldStatus !== 'done';
      if (transitionedToDone) {
        const docsList: string[] = [];
        if (Array.isArray(item.relatedDocs)) {
          for (const d of item.relatedDocs) docsList.push(d);
        }
        const bgRel = resolveBackgroundPath(root, store, args.storyId);
        if (bgRel && !docsList.includes(bgRel)) {
          docsList.push(bgRel);
        }
        if (docsList.length > 0) {
          const lines = docsList.map(d => `  - ${d}`).join('\n');
          return `Checklist ${args.itemId}: ${results.join(', ')}\n\n📄 Related documents (please check whether the code changes affect these documents and sync them while memory is fresh):\n${lines}${commitHint}`;
        }
      }

      return `Checklist ${args.itemId}: ${results.join(', ')}${commitHint}`;
      });
    },

    light_review(args: {
      storyId: string;
      checklistIds: string[];
      note?: string;
    }): string {
      if (!args.storyId) throw new Error('storyId is required');
      if (!Array.isArray(args.checklistIds) || args.checklistIds.length === 0) {
        throw new Error('checklistIds must be a non-empty array');
      }

      // Validate story exists
      store.readStory(args.storyId);

      // Validate checklist item IDs exist
      return withChecklistLock(ctx, args.storyId, () => {
      const cl = store.readChecklist(args.storyId);
      const validIds = new Set(cl.items.map(i => i.id));
      for (const id of args.checklistIds) {
        if (!validIds.has(id)) throw new Error(`Checklist item ${id} not found in ${args.storyId}`);
      }

      // Deduplicate checklistIds
      const uniqueIds = [...new Set(args.checklistIds)];

      // Append process event
      store.appendProcessEvent(args.storyId, {
        type: 'light_review',
        checklistIds: uniqueIds,
        ...(args.note ? { note: args.note } : {}),
      });

      const ids = uniqueIds.join(', ');
      return `Light review recorded for ${args.storyId} (items: ${ids})`;
      });
    },

    verification_evidence_add(args: {
      storyId: string;
      itemId: string;
      intentRef: string;
      kind: VerificationEvidenceKindInput;
      verdict?: VerificationEvidence['verdict'];
      waiverType?: VerificationEvidence['waiverType'];
      file?: string;
      command?: string;
      result?: 'pass' | 'fail';
      note: string;
      attestation?: VerificationEvidence['attestation'];
      actorTrust?: VerificationEvidence['actorTrust'];
      factProvenance?: VerificationEvidence['factProvenance'];
    }): string {
      // Local-only evidence write: record scoped Proofbound evidence and never POST.
      if (!args.note || args.note.trim().length < 5) {
        throw new Error('verification_evidence_add: note must be ≥ 5 characters, explaining why the evidence covers the intent');
      }
      const kind = normalizeEvidenceKind(args.kind);
      if (args.waiverType && kind !== 'waiver') {
        throw new Error('verification_evidence_add: waiverType can only be used with kind=waiver');
      }

      return withChecklistLock(ctx, args.storyId, () => {
        const cl = store.readChecklist(args.storyId);
        const item = cl.items.find(i => i.id === args.itemId);
        if (!item) throw new Error(`Checklist item ${args.itemId} not found`);
        const hashes = evidenceHashes(resolveStoryGitCwd(args.storyId), root);

        const evidence = makeEvidence({
          intentRef: args.intentRef,
          kind,
          ...(args.verdict ? { verdict: args.verdict } : {}),
          ...(args.waiverType ? { waiverType: args.waiverType } : {}),
          ...(args.file ? { file: args.file } : {}),
          ...(args.command ? { command: args.command } : {}),
          ...(args.result ? { result: args.result } : {}),
          note: args.note.trim(),
          ...(args.attestation ? { attestation: args.attestation } : {}),
          ...(args.actorTrust ? { actorTrust: args.actorTrust } : {}),
          ...(args.factProvenance ? { factProvenance: args.factProvenance } : {}),
          ...hashes,
        });

        const existing = item.verificationEvidence || [];
        const idx = existing.findIndex(e => e.intentRef === args.intentRef);
        if (idx >= 0) existing[idx] = evidence;
        else existing.push(evidence);
        item.verificationEvidence = existing;

        store.writeChecklist(args.storyId, cl);
        const aliasNote = kind !== args.kind ? `, alias ${args.kind}` : '';
        const commitHint = autoCommitStoryMetadata(root, args.storyId, 'verification_evidence_add');
        return `Verification evidence recorded for ${args.itemId} → ${args.intentRef} (${kind}${aliasNote})${commitHint}`;
      });
    },

    verification_evidence_batch_add(args: {
      storyId: string;
      evidences: Array<{
        itemId: string;
        intentRef: string;
        kind: VerificationEvidenceKindInput;
        verdict?: VerificationEvidence['verdict'];
        waiverType?: VerificationEvidence['waiverType'];
        file?: string;
        command?: string;
        result?: 'pass' | 'fail';
        note: string;
        attestation?: VerificationEvidence['attestation'];
        actorTrust?: VerificationEvidence['actorTrust'];
        factProvenance?: VerificationEvidence['factProvenance'];
      }>;
    }): string {
      if (!Array.isArray(args.evidences) || args.evidences.length === 0) {
        throw new Error('verification_evidence_batch_add: evidences must be a non-empty array');
      }

      // Local preflight for all entries; any failure throws before the local
      // all-or-nothing batch write.
      const normalizedKinds: VerificationEvidence['kind'][] = [];
      for (const entry of args.evidences) {
        if (!entry.note || entry.note.trim().length < 5) {
          throw new Error(`verification_evidence_batch_add: ${entry.itemId} → ${entry.intentRef} note must be ≥ 5 characters`);
        }
        const kind = normalizeEvidenceKind(entry.kind);
        if (entry.waiverType && kind !== 'waiver') {
          throw new Error(`verification_evidence_batch_add: ${entry.itemId} → ${entry.intentRef} waiverType can only be used with kind=waiver`);
        }
        normalizedKinds.push(kind);
      }

      return withChecklistLock(ctx, args.storyId, () => {
        const cl = store.readChecklist(args.storyId);
        const hashes = evidenceHashes(resolveStoryGitCwd(args.storyId), root);
        let written = 0;
        args.evidences.forEach((entry, i) => {
          const kind = normalizedKinds[i];
          const item = cl.items.find(it => it.id === entry.itemId);
          if (!item) throw new Error(`Checklist item ${entry.itemId} not found`);
          const evidence = makeEvidence({
            intentRef: entry.intentRef,
            kind,
            ...(entry.verdict ? { verdict: entry.verdict } : {}),
            ...(entry.waiverType ? { waiverType: entry.waiverType } : {}),
            ...(entry.file ? { file: entry.file } : {}),
            ...(entry.command ? { command: entry.command } : {}),
            ...(entry.result ? { result: entry.result } : {}),
            note: entry.note.trim(),
            ...(entry.attestation ? { attestation: entry.attestation } : {}),
            ...(entry.actorTrust ? { actorTrust: entry.actorTrust } : {}),
            ...(entry.factProvenance ? { factProvenance: entry.factProvenance } : {}),
            ...hashes,
          });
          const existing = item.verificationEvidence || [];
          const idx = existing.findIndex(e => e.intentRef === entry.intentRef);
          if (idx >= 0) existing[idx] = evidence;
          else existing.push(evidence);
          item.verificationEvidence = existing;
          written++;
        });
        store.writeChecklist(args.storyId, cl);
        const commitHint = autoCommitStoryMetadata(root, args.storyId, 'verification_evidence_batch_add');
        return `Verification evidence batch recorded for ${args.storyId}: ${written} item intent(s)${commitHint}`;
      });
    },

    verification_evidence_refresh_stale(args: {
      storyId: string;
      dryRun?: boolean;
    }): string {
      return withChecklistLock(ctx, args.storyId, () => {
      const cl = store.readChecklist(args.storyId);
      let headHash = '';
      // B-75f0 CHK-001: refresh freshness from the RESOLVED gitRoot, not the bare
      // metadataRoot. On a wrapper-root layout the bare root is not a git repo, so
      // `git rev-parse HEAD` threw and refresh was impossible. metadataRoot stays
      // `root` for the storyDir-aware material exclusion. Plain repos: gitCwd==root.
      const refreshGitCwd = resolveStoryGitCwd(args.storyId);
      try {
        headHash = execSync('git rev-parse HEAD', { cwd: refreshGitCwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
      } catch {
        throw new Error('verification_evidence_refresh_stale: cannot read git HEAD in current directory, unable to refresh freshness');
      }
      const materialHash = currentMaterialHash(refreshGitCwd, 'HEAD', root);
      const storyFilesHash = currentStoryFilesHash(refreshGitCwd, 'HEAD', root);
      const coverage = buildVerificationCoverage(
        cl,
        headHash,
        (oldHeadHash, evidence) => checkEvidenceFreshnessForGit(refreshGitCwd, oldHeadHash, evidence?.materialHash, root, evidence?.storyFilesHash).fresh,
        { deferredGateEvidence: 'missing' },
      );
      const stale = coverage.entries.filter(e => e.status === 'stale' && e.evidence);
      if (stale.length === 0) {
        return `No stale verification evidence for ${args.storyId}`;
      }

      const lines = [
        `${args.dryRun ? '[DRY-RUN] ' : ''}Stale verification evidence for ${args.storyId}: ${stale.length}`,
      ];
      let refreshed = 0;
      for (const entry of stale) {
        const item = cl.items.find(i => i.id === entry.itemId);
        const existing = item?.verificationEvidence || [];
        const idx = existing.findIndex(e => e.intentRef === entry.intentRef);
        const ev = idx >= 0 ? existing[idx] : entry.evidence;
        lines.push(`  - ${entry.intentRef}: ${ev?.command || ev?.file || ev?.kind || 'evidence'} → ${headHash.slice(0, 7)}`);
        if (args.dryRun || !item || idx < 0 || !ev) continue;
        existing[idx] = makeEvidence({
          intentRef: ev.intentRef,
          kind: ev.kind,
          ...(ev.verdict ? { verdict: ev.verdict } : {}),
          ...(ev.waiverType ? { waiverType: ev.waiverType } : {}),
          ...(ev.file ? { file: ev.file } : {}),
          ...(ev.command ? { command: ev.command } : {}),
          ...(ev.result ? { result: ev.result } : {}),
          note: ev.note,
          headHash,
          ...(materialHash ? { materialHash } : {}),
          ...(storyFilesHash ? { storyFilesHash } : {}),
          ...(ev.attestation ? { attestation: ev.attestation } : {}),
          ...(ev.actorTrust ? { actorTrust: ev.actorTrust } : {}),
          ...(ev.factProvenance ? { factProvenance: ev.factProvenance } : {}),
        });
        item.verificationEvidence = existing;
        refreshed++;
      }

      if (!args.dryRun) store.writeChecklist(args.storyId, cl);
      lines.push(args.dryRun
        ? '→ Rerun the above command without dryRun to refresh evidence metadata'
        : `Refreshed ${refreshed}/${stale.length} stale evidence item(s). Re-run lattice validate --story=${args.storyId} --json`);
      if (!args.dryRun) {
        const commitHint = autoCommitStoryMetadata(root, args.storyId, 'verification_evidence_refresh_stale');
        if (commitHint) lines.push(commitHint.replace(/^\n/, ''));
      }
      return lines.join('\n');
      });
    },

    /**
     * B-4e06 CHK-001: audited legacy repair. Reconstructs ONLY missing
     * verificationIntent lanes from existing PASSING verificationEvidence, for
     * mid-flight stories adopted after evidence was already recorded. Never
     * overwrites authored intent; fail-closed on malformed refs; synthesized
     * intents are priority='should' so the backfill can never retroactively
     * weaponize the hard coverage gate. Refused in INIT/INIT_CHECK/terminal.
     */
    verification_intent_repair(args: {
      storyId: string;
      mode: 'fromEvidence';
      legacyRepair: boolean;
      reason: string;
      dryRun?: boolean;
    }): string {
      // --- LOCAL PREFLIGHT (fail-closed, BEFORE any read/write) ----------------
      if (args.mode !== 'fromEvidence') {
        throw new Error("verification_intent_repair: mode must be 'fromEvidence' (the only supported mode)");
      }
      if (args.legacyRepair !== true) {
        throw new Error('verification_intent_repair: legacyRepair must be explicitly true — confirm this is a legacy evidence-without-intent backfill, not normal PLAN work');
      }
      if (!args.reason || args.reason.trim().length < 30) {
        throw new Error('verification_intent_repair: reason must be ≥ 30 characters (substantial justification of what you verified)');
      }
      const story = assertChecklistMutationCwd(store, args.storyId);
      if (INTENT_REPAIR_REFUSED_PHASES.has(story.phase)) {
        throw new Error(`verification_intent_repair refused in ${story.phase} phase: only PLAN/DEV/REVIEW/TEST stories with mid-flight evidence can be repaired`);
      }
      return withChecklistLock(ctx, args.storyId, () => {
        const cl = store.readChecklist(args.storyId);
        const filled = reconstructMissingIntentsFromEvidence(cl);
        const header = `${args.dryRun ? '[DRY-RUN] ' : ''}verification_intent_repair (fromEvidence) for ${args.storyId}`;
        if (filled.length === 0) {
          return `${header}\nNo missing verificationIntent lanes with passing evidence — nothing to repair.`;
        }
        const lines = [header, `Reconstructed ${filled.length} intent lane(s) from passing evidence:`, ...filled.map(f => `  + ${f}`)];
        if (args.dryRun) {
          lines.push('→ Rerun without dryRun to write these reconstructed intents (priority=should).');
          return lines.join('\n');
        }
        store.writeChecklist(args.storyId, cl);
        const commitHint = autoCommitStoryMetadata(root, args.storyId, 'verification_intent_repair');
        lines.push(`Wrote ${filled.length} reconstructed intent(s). Re-run lattice validate --story=${args.storyId} --json`);
        if (commitHint) lines.push(commitHint.replace(/^\n/, ''));
        return lines.join('\n');
      });
    },


  };
}
