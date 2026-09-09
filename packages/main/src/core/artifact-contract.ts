import { rethrowIntentAmendmentIntegrityError } from './verification-intent-amendment.js';
/**
 * B-7c1b CHK-005: Artifact contract -- per-phase completeness check.
 *
 * Pure read-only module. Given a StoryStore + storyId + phase, returns which
 * artifacts are required, which are present, and a human-readable detail.
 *
 * Adapted from Orchestrate artifact-contract.ts to cover proofOrStop's artifact set:
 *   understanding, decision, scope-check, init-check, delivery-check,
 *   plan.md, test-evidence, eval-evidence, summary, checklist-all-done, findings.
 */

import { existsSync } from 'fs';
import { join } from 'path';
import type { StoryPhase, StoryInfo } from './types.js';
import type { StoryStore } from './store.js';
import { summarizeReviewerStatus } from './reviewer-status.js';
import { isTerminalChecklistStatus } from './checklist-status.js';

// ── Public types ──

export type ArtifactKey =
  | 'init-check'
  | 'understanding'
  | 'decision'
  | 'scope-check'
  | 'plan-md'
  | 'checklist-all-done'
  | 'findings-clear'
  | 'test-evidence'
  | 'delivery-check'
  | 'eval-evidence'
  | 'summary';

export interface ArtifactStatus {
  /** Machine-readable key */
  name: ArtifactKey;
  /** Whether this artifact is required for the given phase */
  required: boolean;
  /** Whether the artifact currently exists / satisfies its condition */
  present: boolean;
  /** Human-readable explanation */
  detail?: string;
}

export interface ArtifactContractResult {
  phase: StoryPhase;
  entries: ArtifactStatus[];
}

// ── Helpers ──

function isHighRisk(story: StoryInfo): boolean {
  return (
    story.priority === 'high'
    || story.priority === 'critical'
    || (story.riskSignals?.length ?? 0) > 0
  );
}

function hasUnderstanding(store: StoryStore, storyId: string): boolean {
  try {
    const data = store.readUnderstanding(storyId);
    return !!data && !!data.task;
  } catch {
    return false;
  }
}

function hasDecision(store: StoryStore, storyId: string): boolean {
  try {
    const data = store.readDecision(storyId);
    return !!data && Array.isArray(data.options) && data.options.length > 0;
  } catch {
    return false;
  }
}

function hasScopeCheck(store: StoryStore, storyId: string): boolean {
  try {
    return store.readScopeCheck(storyId) !== null;
  } catch {
    return false;
  }
}

function hasInitCheck(store: StoryStore, storyId: string): boolean {
  try {
    return store.readInitCheck(storyId) !== null;
  } catch {
    return false;
  }
}

function hasDeliveryCheck(store: StoryStore, storyId: string): boolean {
  try {
    return store.readDeliveryCheck(storyId) !== null;
  } catch {
    return false;
  }
}

function hasPlanMd(storyDir: string): boolean {
  return existsSync(join(storyDir, 'plan.md'));
}

function hasTestEvidencePass(store: StoryStore, storyId: string): boolean {
  try {
    const ev = store.readTestEvidence(storyId);
    return !!ev && ev.result === 'PASS';
  } catch {
    return false;
  }
}

function hasEvalEvidence(store: StoryStore, storyId: string): boolean {
  try {
    return store.readEvalEvidence(storyId) !== null;
  } catch {
    return false;
  }
}

function hasSummary(store: StoryStore, storyId: string): boolean {
  try {
    return store.readSummary(storyId) !== null;
  } catch {
    return false;
  }
}

function isChecklistAllDone(store: StoryStore, storyId: string): boolean {
  try {
    const cl = store.readChecklist(storyId);
    // B-1909 CHK-002: a withdrawn item is terminal (accounted for), so a
    // checklist of done+withdrawn items counts as all-done for phase readiness.
    return cl.items.length > 0 && cl.items.every(i => isTerminalChecklistStatus(i.status));
  } catch (intentIntegrityError) { rethrowIntentAmendmentIntegrityError(intentIntegrityError);
    return false;
  }
}

// ── Main ──

/**
 * Returns the artifact contract for a story at a given phase.
 *
 * Each entry describes whether an artifact is required, whether it is present,
 * and a human-readable detail. Callers (e.g. `proof-or-stop status`) can render this
 * as a checklist to show the agent what's missing.
 *
 * @param store   - StoryStore instance
 * @param storyId - e.g. "B-7c1b"
 * @param phase   - current story phase
 * @param opts    - optional overrides (projectRoot for plan.md detection)
 */
export function getArtifactContractStatus(
  store: StoryStore,
  storyId: string,
  phase: StoryPhase,
  opts?: { projectRoot?: string },
): ArtifactContractResult {
  let story: StoryInfo;
  try {
    story = store.readStory(storyId);
  } catch {
    return { phase, entries: [] };
  }

  const highRisk = isHighRisk(story);

  const storyDir = opts?.projectRoot ? store.storyDirPath(storyId) : '';

  // Phase sets where each artifact is required
  const PLAN_AND_AFTER: StoryPhase[] = ['PLAN', 'DEV', 'REVIEW', 'TEST', 'DONE'];
  const DEV_AND_AFTER: StoryPhase[] = ['DEV', 'REVIEW', 'TEST', 'DONE'];
  const TEST_AND_AFTER: StoryPhase[] = ['TEST', 'DONE'];

  const inPhaseSet = (p: StoryPhase, set: StoryPhase[]) => set.includes(p);

  const entries: ArtifactStatus[] = [
    // init-check: required from INIT_CHECK onward
    {
      name: 'init-check',
      required: phase !== 'INIT' && phase !== 'IDEA',
      present: hasInitCheck(store, storyId),
      detail: 'init reviewer signed artifact (INIT→INIT_CHECK hard gate)',
    },

    // understanding: required from PLAN onward
    {
      name: 'understanding',
      required: inPhaseSet(phase, PLAN_AND_AFTER),
      present: hasUnderstanding(store, storyId),
      detail: 'task / outcome / facts / constraints / unknowns / touchpoints snapshot',
    },

    // decision: required for high-risk stories from PLAN onward
    {
      name: 'decision',
      required: inPhaseSet(phase, PLAN_AND_AFTER) && highRisk,
      present: hasDecision(store, storyId),
      detail: highRisk
        ? 'High-risk story must have principles / drivers / options / rationale / preMortem'
        : 'Optional for non-high-risk story',
    },

    // scope-check: required from PLAN onward (normal channel)
    {
      name: 'scope-check',
      required: inPhaseSet(phase, PLAN_AND_AFTER),
      present: hasScopeCheck(store, storyId),
      detail: 'scope-plan reviewer signed artifact (PLAN→DEV hard gate)',
    },

    // plan.md: required from DEV onward (normal channel, if projectRoot available)
    {
      name: 'plan-md',
      required: inPhaseSet(phase, DEV_AND_AFTER),
      present: storyDir ? hasPlanMd(storyDir) : false,
      detail: storyDir
        ? 'Execution plan (one section per CHK-xxx)'
        : 'Execution plan (requires projectRoot detection)',
    },

    // checklist-all-done: required from REVIEW onward
    {
      name: 'checklist-all-done',
      required: phase === 'REVIEW' || inPhaseSet(phase, TEST_AND_AFTER),
      present: isChecklistAllDone(store, storyId),
      detail: 'All checklist items status=done',
    },

    // findings-clear: required at TEST (all blocking findings resolved)
    {
      name: 'findings-clear',
      required: inPhaseSet(phase, TEST_AND_AFTER),
      present: (() => {
        try {
          const rs = summarizeReviewerStatus(store, storyId, opts?.projectRoot);
          return rs.allPassed;
        } catch {
          return false;
        }
      })(),
      detail: 'All blocking findings resolved/dismissed',
    },

    // test-evidence PASS: required from TEST onward
    {
      name: 'test-evidence',
      required: inPhaseSet(phase, TEST_AND_AFTER),
      present: hasTestEvidencePass(store, storyId),
      detail: 'Latest proof-or-stop validate result is PASS',
    },

    // delivery-check: required at DONE
    {
      name: 'delivery-check',
      required: phase === 'DONE' || phase === 'TEST',
      present: hasDeliveryCheck(store, storyId),
      detail: 'delivery reviewer signed artifact (TEST→DONE hard gate)',
    },

    // eval-evidence: advisory at DONE (browser projects)
    {
      name: 'eval-evidence',
      required: phase === 'DONE',
      present: hasEvalEvidence(store, storyId),
      detail: 'evaluator scoring evidence (consumed by browser project DONE gate)',
    },

    // summary: required at DONE
    {
      name: 'summary',
      required: phase === 'DONE',
      present: hasSummary(store, storyId),
      detail: 'changes / usage / limitations / pitfalls completion summary',
    },
  ];

  return { phase, entries };
}
