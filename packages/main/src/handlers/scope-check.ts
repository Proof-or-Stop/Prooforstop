import { signPlanOwnerCoverage } from '../core/plan-touchpoint-coverage.js';
/**
 * Scope Check handler — proof-or-stop scope_check_save
 *
 * Lets the scope agent subagent write a signed scope-check.json.
 * The _hash field allows story_review to verify integrity (prevent manual forgery).
 */

import { createHash } from 'crypto';
import { existsSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import type { HandlerContext } from './context.js';
import type { ScopeCheckData, OpenQuestion } from '../core/types.js';
import { autoCommitStoryMetadata } from '../core/auto-commit-metadata.js';
import { digestCanonicalJson } from '../core/digest.js';
import { normalizeReviewerReadManifest } from '../core/reviewer-read-evidence.js';
import { assertCandidateReadBinding, digestCandidateRoutingValue } from '../core/candidate-spec-routing.js';
import { currentStoryRoutingInput } from './candidate-spec-routing.js';
import { captureReviewRunSnapshot } from '../core/review-run.js';
import { loadConfig } from '../core/config.js';
import { CONFIG_FILENAMES, stateDirCandidates } from '../core/brand-paths.js';
import { resolveAgentMutationAuthority } from '../core/agent-dispatch-registry.js';
import { resolveManagedDispatchInvocation } from '../core/managed-host-run.js';
import {
  SCOPE_CHECK_SALT,
  scopeCheckContentHash,
  scopeReviewChecklistDigest,
  verifyScopeCheckContentSignature,
  type ScopeCheckSignatureMaterial,
} from '../core/scope-check-integrity.js';

export { SCOPE_CHECK_SALT } from '../core/scope-check-integrity.js';
export type { ScopeCheckSignatureMaterial } from '../core/scope-check-integrity.js';

function legacyScopeCheckHash(storyId: string, timestamp: string, gaps: number, covered: number, reviewRound: string): string {
  return createHash('sha256')
    .update(`${storyId}:${timestamp}:${gaps}:${covered}:${reviewRound}:${SCOPE_CHECK_SALT}`)
    .digest('hex');
}

function v2ScopeCheckHash(
  storyId: string,
  timestamp: string,
  reviewRound: string,
  material: ScopeCheckSignatureMaterial,
): string {
  return scopeCheckContentHash(storyId, timestamp, reviewRound, material);
}

function configuredStoryDirs(root: string): string[] {
  // B-cc10 CHK-004: derive the default story dirs from the resolver so both
  // state-dir spellings are accepted, and read the config under BOTH filenames.
  const dirs = [...stateDirCandidates('story', 'actives'), 'docs/story/actives'];
  for (const filename of CONFIG_FILENAMES) {
    try {
      const parsed = JSON.parse(readFileSync(join(root, filename), 'utf8')) as { storyDir?: unknown };
      if (typeof parsed.storyDir === 'string' && parsed.storyDir.trim()) {
        dirs.unshift(parsed.storyDir.trim());
      }
      break;
    } catch {
      // Best-effort compatibility shim for legacy signScopeCheck callers; try the
      // next accepted spelling before giving up.
    }
  }
  return [...new Set(dirs)];
}

function findProjectRoot(start: string): string {
  let dir = start;
  while (true) {
    // B-cc10 CHK-004: a project-root marker test must accept BOTH config
    // filenames. Recognizing only one spelling is the B-cdf6 F-065 shape: an
    // already-migrated project would stop being found and root discovery would
    // silently fall back to `start`.
    if (CONFIG_FILENAMES.some((name) => existsSync(join(dir, name)))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return start;
    dir = parent;
  }
}

function persistedScopeCheckMaterial(
  storyId: string,
  timestamp: string,
  gaps: number,
  covered: number,
  reviewRound: string,
): ScopeCheckSignatureMaterial | 'invalid-readManifest' | null {
  const projectRoot = findProjectRoot(process.cwd());
  for (const storyDir of configuredStoryDirs(projectRoot)) {
    const file = join(projectRoot, storyDir, storyId, 'scope-check.json');
    if (!existsSync(file)) continue;
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8')) as ScopeCheckData;
      if (
        raw.storyId !== storyId
        || raw.checkedAt !== timestamp
        || raw.summary?.gaps !== gaps
        || raw.summary?.covered !== covered
        || (raw.reviewRound || '') !== reviewRound
      ) {
        continue;
      }
      if (raw.readManifest === undefined) return null;
      try {
        const readManifest = normalizeReviewerReadManifest(raw.readManifest);
        return {
          features: raw.features || [],
          summary: {
            total: raw.summary?.total ?? 0,
            covered: raw.summary?.covered ?? 0,
            excluded: raw.summary?.excluded ?? 0,
            gaps: raw.summary?.gaps ?? 0,
            orphanSuspect: raw.summary?.orphanSuspect ?? 0,
            drift: raw.summary?.drift ?? 0,
          },
          readManifest,
        };
      } catch {
        return 'invalid-readManifest';
      }
    } catch {
      return null;
    }
  }
  return null;
}

export function signScopeCheck(
  storyId: string,
  timestamp: string,
  gaps: number,
  covered: number,
  reviewRound: string = '',
  material?: ScopeCheckSignatureMaterial,
): string {
  if (material) return v2ScopeCheckHash(storyId, timestamp, reviewRound, material);

  const persisted = persistedScopeCheckMaterial(storyId, timestamp, gaps, covered, reviewRound);
  if (persisted === 'invalid-readManifest') {
    return digestCanonicalJson({ version: 2, salt: SCOPE_CHECK_SALT, storyId, timestamp, reviewRound, invalid: 'readManifest' });
  }
  if (persisted) return v2ScopeCheckHash(storyId, timestamp, reviewRound, persisted);
  return legacyScopeCheckHash(storyId, timestamp, gaps, covered, reviewRound);
}

export function verifyScopeCheckSignature(storyId: string, data: ScopeCheckData): boolean {
  if (!data._hash || !data.checkedAt || !data.summary) return false;
  if (data.readManifest !== undefined) {
    return verifyScopeCheckContentSignature(storyId, data);
  }
  return data._hash === legacyScopeCheckHash(storyId, data.checkedAt, data.summary.gaps, data.summary.covered, data.reviewRound || '');
}

export function createScopeCheckHandlers(ctx: HandlerContext): Record<string, (...args: any[]) => any> {
  const { store, root } = ctx;
  return {
    scope_check_save(args: {
      storyId: string;
      features: Array<{
        feature: string;
        covered_by: string | null;
        // B-ed3e CHK-002: 5-tier status
        status: 'covered' | 'excluded' | 'gap' | 'orphan-suspect' | 'drift';
        excluded_by: string | null;
        source?: string;
      }>;
      summary: {
        total: number;
        covered: number;
        excluded: number;
        gaps: number;
        // B-ed3e CHK-002: new field is optional (backward compatible with old callers), defaults to 0
        orphanSuspect?: number;
        drift?: number;
      };
      readManifest: unknown;
      ownerDispositions?: unknown;
      // B-ed3e CHK-003: 6th channel Open Questions (optional). Not validated when reviewer writes
      // business integrity (only type check); main agent later resolves via scope_question_resolve.
      openQuestions?: OpenQuestion[];
    }): string {
      const authority = resolveAgentMutationAuthority({ command: 'scope_check_save' });
      const managedInvocation = process.env.LATTICE_MANAGED_INIT_INVOCATION?.trim();
      const managedActor = authority.entry?.canonicalName ?? authority.actor;
      if (managedInvocation && managedActor !== 'proof-or-stop-review-scope-plan') {
        throw new Error('scope_check_save refused: managed dispatch requires proof-or-stop-review-scope-plan authority');
      }
      const ownerCoverage = signPlanOwnerCoverage(store, root, args.storyId, args.ownerDispositions, authority.source === 'dispatched-env' ? authority.entry?.canonicalName : undefined);
      // Verify story exists and read currentReviewRound
      let reviewRound = '';
      try {
        const story = store.readStory(args.storyId);
        reviewRound = story.currentReviewRound || '';
      } catch {
        throw new Error(`Story ${args.storyId} not found`);
      }
      const timestamp = new Date().toISOString();
      const readManifest = normalizeReviewerReadManifest(args.readManifest, 'scope_check_save.readManifest');
      const routingMode = loadConfig(root).candidateSpecRouting?.mode ?? 'shadow';
      if (routingMode === 'enforce' || readManifest.candidateSpecSetDigest) {
        const snapshot = captureReviewRunSnapshot(root, { storyId: args.storyId, storyPhase: 'PLAN' });
        assertCandidateReadBinding({
          manifest: readManifest,
          artifact: store.readCandidateSpecSet(args.storyId),
          mode: routingMode,
          currentMaterialHash: snapshot.materialHash,
          currentStoryFilesHash: snapshot.storyFilesHash,
          currentStoryInputDigest: digestCandidateRoutingValue(currentStoryRoutingInput(ctx, args.storyId)),
        });
      }
      const orphanSuspect = args.summary.orphanSuspect ?? 0;
      const drift = args.summary.drift ?? 0;
      const summary = {
        total: args.summary.total,
        covered: args.summary.covered,
        excluded: args.summary.excluded,
        gaps: args.summary.gaps,
        orphanSuspect,
        drift,
      };
      // Validate the complete reviewer payload before consuming its one-shot
      // managed invocation. A provider may correct a rejected tool call within
      // the same run; only a payload that is ready to persist earns delivery.
      // Old-PoS run 20: (1) a second save of the same live run was refused as
      // "already consumed", and (2) the reviewer then saved under
      // `env -u LATTICE_MANAGED_INIT_INVOCATION`, which wrote an unbound
      // scope-check over its bound one, so the run ended output_missing.
      // A save of the live run re-binds (reseal), and a scope reviewer save
      // without the invocation while its managed run is live must bind through
      // the run's process group or be refused; it never writes unbound output.
      const managedDeliveryRunId = managedInvocation
        ? resolveManagedDispatchInvocation({ root, storyId: args.storyId, agentType: managedActor!, reseal: true, command: 'scope_check_save' })
        : managedActor === 'proof-or-stop-review-scope-plan'
          ? resolveManagedDispatchInvocation({ root, storyId: args.storyId, agentType: managedActor, reseal: true,
            command: 'scope_check_save', optionalWhenAbsent: true })
          : undefined;
      const _hash = signScopeCheck(args.storyId, timestamp, args.summary.gaps, args.summary.covered, reviewRound, {
        features: args.features,
        summary,
        readManifest,
        ...(managedDeliveryRunId ? { deliveryRunId: managedDeliveryRunId } : {}),
      });
      // Guidance-only binding (see scopeReviewChecklistDigest); an unreadable
      // checklist simply omits it and story_review falls back to the generic hint.
      let checklistDigest: string | undefined;
      try { checklistDigest = scopeReviewChecklistDigest(store.readChecklist(args.storyId)); } catch { checklistDigest = undefined; }
      const data: ScopeCheckData = {
        storyId: args.storyId,
        ...(managedDeliveryRunId ? { deliveryRunId: managedDeliveryRunId } : {}),
        ...(ownerCoverage ? {ownerCoverage} : {}),
        checkedAt: timestamp,
        features: args.features,
        readManifest,
        summary,
        reviewRound,
        ...(checklistDigest ? { checklistDigest } : {}),
        _hash,
      };
      // B-ed3e CHK-003: openQuestions passed through as-is (not in signature domain), field omitted when absent.
      // F-007/F-015: empty array [] is preserved as openQuestions:[], distinguishing "scanned with 0 OQ" (new agent)
      // from "OQ field not generated" (old agent), two distinct semantics. Only passing undefined omits the field.
      if (Array.isArray(args.openQuestions)) {
        data.openQuestions = args.openQuestions;
      }
      store.writeScopeCheck(args.storyId, data);
      const oqCount = args.openQuestions?.length ?? 0;
      const oqSuffix = oqCount > 0 ? `, open-questions=${oqCount}` : '';
      const commitHint = autoCommitStoryMetadata(root, args.storyId, 'scope_check_save');
      return `Scope check saved for ${args.storyId}: ${args.summary.covered} covered, ${args.summary.excluded} excluded, ${args.summary.gaps} gaps, orphan-suspect=${orphanSuspect}, drift=${drift}${oqSuffix}${commitHint}`;
    },
  };
}
