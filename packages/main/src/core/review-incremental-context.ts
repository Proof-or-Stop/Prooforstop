/**
 * B-f675 CHK-001: read-only incremental review context.
 *
 * Gives a reviewer role its most recent prior verdict (review-pass or finding)
 * for the current story, the headHash that verdict was bound to, and the set of
 * MATERIAL files that changed since that headHash. When the reviewer has never
 * passed on this story it reports isFirstPass=true and the full main...HEAD
 * material diff.
 *
 * HARD INVARIANT (this story): this module is STRICTLY READ-ONLY. It only reads
 * via the StoryStore and git; it performs no writes and has no gate/store side
 * effects. It does NOT touch canPassReviewGuard, review-run bindings,
 * materialHash, or staleness logic — it only surfaces information so an operator
 * can decide whether to re-run a reviewer. The framework still skips nobody.
 *
 * Diff source: changedFilesBetweenRenameAware (`git diff --name-status -M`) so a
 * file rename since the reviewer's last pass still surfaces as a changed path
 * (rather than being hidden by a name-only collapse). Results are filtered to
 * material files via isMaterialExcludedPath so story-metadata-only churn does
 * not falsely flag scopeChanged.
 */

import { execFileSync } from 'node:child_process';
import type { StoryStore } from './store.js';
import type { Finding, ReviewPass, ReviewRun } from './types.js';
import {
  changedFilesBetweenRenameAware,
  changedFileStatusesBetweenRenameAware,
  checkEvidenceFreshnessForGit,
  classifyEvidenceFreshness,
  currentGitHead,
  currentMaterialHash,
  currentStoryFilesHash,
  isMaterialExcludedPath,
  type EvidenceFreshnessClassification,
} from './evidence-freshness.js';
import { verifyReviewPass } from './finding-verify.js';
import { verifyReviewRun } from './review-run.js';
import {
  classifyImpact,
  IMPACT_CLASSIFICATION_POLICY_VERSION,
  type ImpactClassification,
} from './impact-classification-policy.js';
import {
  domainSeparatedDigest,
  validateIncrementalReviewBasis,
  type IncrementalReviewBasis,
} from './prompt-contracts.js';
import {
  PROMPT_DISPATCH_PROTOCOL_VERSION,
  PROMPT_ENVELOPE_ASSEMBLER_VERSION,
  buildFullTaskContext,
  captureKnownExecutionEnvironment,
  fullTaskSemanticDigest,
  verifyPromptEnvelopeIntegrity,
} from './prompt-envelope.js';
import { BASELINE_RUNTIME_CONTRACT } from './prompt-measurement.js';
import { promptRoleContract } from './prompt-role-contract-registry.js';
import { digestScopeContract } from './guard-session.js';

export interface ReviewIncrementalContext {
  /** The reviewer role this context was computed for (echoed back). */
  role: string;
  /**
   * Authoritative "no usable incremental baseline" signal. `isFirstPass=true`
   * means there is NO resolvable prior-pass headHash to diff against, which
   * covers BOTH sub-cases:
   *   (a) the reviewer has never passed/finding-ed on this story, AND
   *   (b) a prior verdict EXISTS but the run it was bound to has a missing /
   *       unresolvable headHash (so we cannot compute an incremental base).
   * In both sub-cases `priorHeadHash` is null and `changedFiles` is the full
   * `main...HEAD` material diff. Consumers MUST treat `isFirstPass` — NOT
   * `priorVerdict` — as the authoritative "no incremental baseline" flag.
   */
  isFirstPass: boolean;
  /**
   * The headHash the prior verdict was bound to, when resolvable. Always null
   * whenever `isFirstPass=true` (including sub-case (b) above). Non-null only
   * when `isFirstPass=false`, in which case it is the base of the incremental
   * `changedFiles` diff.
   */
  priorHeadHash: string | null;
  /**
   * Human summary of the most recent prior verdict (e.g. "PASS (RP-001)" or
   * "finding F-002: high"), or null when the reviewer has no prior verdict.
   * INFORMATIONAL ONLY. It MAY be non-null even when `isFirstPass=true`: in
   * sub-case (b) a prior verdict exists but its bound headHash is unresolvable,
   * so `priorVerdict` is non-null yet `priorHeadHash` is null and the full diff
   * is returned. Never infer "has incremental baseline" from `priorVerdict`;
   * use `isFirstPass` for that.
   */
  priorVerdict: string | null;
  /**
   * Whether any MATERIAL file changed relative to the baseline. When
   * `isFirstPass=false` this equals `changedFiles.length > 0`. When
   * `isFirstPass=true` it is forced to true (a first pass conservatively
   * "shows everything"), so it MAY be true even if `changedFiles` is empty —
   * do not assume `scopeChanged === (changedFiles.length > 0)` in that branch.
   */
  scopeChanged: boolean;
  /**
   * Material files changed since the baseline. When `isFirstPass=true` this is
   * the full `main...HEAD` material diff; otherwise the diff from
   * `priorHeadHash` to HEAD (rename-aware, material-filtered).
   */
  changedFiles: string[];
  contextMode: 'full' | 'incremental';
  impactPolicyVersion: typeof IMPACT_CLASSIFICATION_POLICY_VERSION;
  freshnessClassification: EvidenceFreshnessClassification | 'NOT_EVALUATED';
  eligibilityReasonCodes: string[];
  eligibilityDigest: string;
  impact: ImpactClassification;
  priorPassRef: string | null;
  priorReviewRunId: string | null;
  currentHeadHash: string | null;
  currentMaterialHash: string | null;
  currentStoryFilesHash: string | null;
  changedFilesDigest: string;
  impactedFiles: string[];
  impactedFilesDigest: string;
  reviewBasis: IncrementalReviewBasis | null;
  reviewBasisDigest: string | null;
  taskSemanticDigest: string | null;
}

interface TrustedPriorPass {
  pass: ReviewPass;
  run: ReviewRun;
}

export interface IncrementalBindingAssessment {
  priorEnvelopePresent: boolean;
  runtimeContractMatches: boolean;
  roleContractMatches: boolean;
  executionEnvironmentMatches: boolean;
  assemblerMatches: boolean;
  dispatchProtocolMatches: boolean;
  scopePolicyMatches: boolean;
  taskSemanticDigestMatches: boolean;
  freshnessClassification: EvidenceFreshnessClassification;
  pureFixtureDrift: boolean;
}

/** Stable forced-full campaign surface consumed by the production assembler. */
export function classifyIncrementalBindingReasons(input: IncrementalBindingAssessment): string[] {
  const reasons: string[] = [];
  if (!input.priorEnvelopePresent) reasons.push('FULL_MISSING_PRIOR_ENVELOPE');
  if (!input.runtimeContractMatches) reasons.push('FULL_RUNTIME_CONTRACT_CHANGED');
  if (!input.roleContractMatches) reasons.push('FULL_ROLE_CONTRACT_CHANGED');
  if (!input.executionEnvironmentMatches) reasons.push('FULL_EXECUTION_ENVIRONMENT_CHANGED');
  if (!input.assemblerMatches) reasons.push('FULL_ASSEMBLER_CHANGED');
  if (!input.dispatchProtocolMatches) reasons.push('FULL_DISPATCH_PROTOCOL_CHANGED');
  if (!input.scopePolicyMatches) reasons.push('FULL_SCOPE_OR_POLICY_CHANGED');
  if (!input.taskSemanticDigestMatches) reasons.push('FULL_MODEL_RELEVANT_TASK_CONTEXT_CHANGED');
  if (['CURRENT_MATERIAL', 'KNOWN_METADATA_ONLY_HEAD_DRIFT'].includes(input.freshnessClassification)) {
    reasons.push('ELIGIBLE_TRUSTED_PRIOR_BINDINGS');
  } else if (input.pureFixtureDrift) {
    reasons.push('ELIGIBLE_RELATED_PURE_STORY_FIXTURE_DRIFT');
  } else {
    reasons.push(`FULL_FRESHNESS_${input.freshnessClassification}`);
  }
  return reasons;
}

function verdictTime(value: string | undefined): number {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function latestTrustedPriorPass(
  store: StoryStore,
  storyId: string,
  role: string,
  passes: ReviewPass[],
  runs: ReviewRun[],
  excludedReviewRunId?: string,
): TrustedPriorPass | null {
  const candidates: TrustedPriorPass[] = [];
  for (const pass of passes) {
    if (pass.agent !== role || !verifyReviewPass(storyId, pass) || !pass.reviewRunId) continue;
    if (pass.reviewRunId === excludedReviewRunId) continue;
    const run = runs.find(candidate => candidate.reviewRunId === pass.reviewRunId);
    if (!run || run.lane !== role || !verifyReviewRun(run)) continue;
    if (!run.envelopeId || pass.envelopeId !== run.envelopeId || !run.assembledPrompt) continue;
    const envelopes = store.readPromptEnvelopes(storyId).envelopes.filter(
      envelope => envelope.envelopeId === run.envelopeId,
    );
    if (envelopes.length !== 1) continue;
    const envelope = envelopes[0];
    if (!verifyPromptEnvelopeIntegrity(envelope)) continue;
    if (
      envelope.storyId !== storyId
      || envelope.roleId !== role
      || envelope.lane !== role
      || envelope.reviewRunId !== run.reviewRunId
      || envelope.reviewRound !== run.reviewRound
      || envelope.headHash !== run.headHash
      || envelope.materialHash !== run.materialHash
      || envelope.storyFilesHash !== run.storyFilesHash
      || envelope.assembledPromptDigest !== run.promptHash
    ) continue;
    candidates.push({ pass, run });
  }
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => verdictTime(a.pass.createdAt) - verdictTime(b.pass.createdAt));
  return candidates[candidates.length - 1];
}

function materialOnly(files: string[], projectRoot: string): string[] {
  return files.filter((file) => !isMaterialExcludedPath(file, projectRoot));
}

function gitFileAt(gitCwd: string, ref: string, path: string): string | null {
  try {
    return execFileSync('git', ['show', `${ref}:${path}`], {
      cwd: gitCwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return null;
  }
}

function fixtureCases(raw: string | null): Array<Record<string, unknown>> | null {
  if (raw === null) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || !Array.isArray((parsed as { cases?: unknown }).cases)) return null;
    const cases = (parsed as { cases: unknown[] }).cases;
    if (!cases.every(value => value && typeof value === 'object' && !Array.isArray(value))) return null;
    return cases as Array<Record<string, unknown>>;
  } catch {
    return null;
  }
}

function fixtureCaseKey(value: Record<string, unknown>, index: number): string {
  for (const field of ['_id', 'id', 'name']) {
    const candidate = value[field];
    if (typeof candidate === 'string' && candidate.trim()) return `${field}:${candidate.trim()}`;
  }
  return `index:${index}`;
}

function canonicalFixtureCaseSet(
  cases: Array<Record<string, unknown>>,
): Map<string, Record<string, unknown>> | null {
  const result = new Map<string, Record<string, unknown>>();
  const identityOwners = new Map<string, number>();
  for (const [index, value] of cases.entries()) {
    // All supported identity aliases participate in uniqueness, not only the
    // highest-priority field selected by fixtureCaseKey. Otherwise an `_id:x`
    // case and a later `id:x`/`name:x` case can ambiguously identify the same
    // logical case while occupying different Map keys.
    for (const field of ['_id', 'id', 'name']) {
      const candidate = value[field];
      if (typeof candidate !== 'string' || !candidate.trim()) continue;
      const alias = candidate.trim();
      const owner = identityOwners.get(alias);
      if (owner !== undefined && owner !== index) return null;
      identityOwners.set(alias, index);
    }
    const key = fixtureCaseKey(value, index);
    if (result.has(key)) return null;
    result.set(key, value);
  }
  return result;
}

/**
 * Proves case-level closure from trusted git objects. File-level declarations
 * are insufficient: every new/changed case must carry a current Story-scoped
 * positional intentRef and removed cases fail closed.
 */
export function fixtureCaseClosure(
  gitCwd: string,
  baseRef: string,
  storyId: string,
  path: string,
  currentStoryIntentRefs: ReadonlySet<string>,
): boolean {
  const before = fixtureCases(gitFileAt(gitCwd, baseRef, path));
  const after = fixtureCases(gitFileAt(gitCwd, 'HEAD', path));
  if (!before || !after) return false;
  // Reject duplicate/ambiguous identities in both snapshots before any Map or
  // digest comparison. This makes overwrite order irrelevant and prevents an
  // unbound duplicate from hiding behind an unchanged later occurrence.
  const prior = canonicalFixtureCaseSet(before);
  const current = canonicalFixtureCaseSet(after);
  if (!prior || !current) return false;
  if ([...prior.keys()].some(key => !current.has(key))) return false;
  const storyPrefix = `${storyId}:`;
  for (const [key, value] of current) {
    const previous = prior.get(key);
    if (previous && domainSeparatedDigest('fixture-case.v1', previous) === domainSeparatedDigest('fixture-case.v1', value)) {
      continue;
    }
    const intentRef = typeof value.intentRef === 'string' ? value.intentRef.trim() : '';
    if (!intentRef.startsWith(storyPrefix) || !currentStoryIntentRefs.has(intentRef)) return false;
  }
  return true;
}

/**
 * Read-only incremental review context for a reviewer `role` on `storyId`.
 *
 * - A prior pass/finding with a bound, resolvable headHash → diff that headHash
 *   against HEAD (rename-aware, material-filtered); scopeChanged = changed > 0;
 *   isFirstPass = false.
 * - No prior verdict (or prior verdict has no resolvable bound headHash) →
 *   isFirstPass = true, priorHeadHash = null, scopeChanged = true, and
 *   changedFiles = the full main...HEAD material diff.
 */
export function reviewIncrementalContext(
  store: StoryStore,
  projectRoot: string,
  storyId: string,
  role: string,
  options: { excludedReviewRunId?: string; findingsCutoffAt?: string } = {},
): ReviewIncrementalContext {
  const passes = store.readReviewPasses(storyId).passes || [];
  const runs = store.readReviewRuns(storyId).runs || [];
  const findings = store.readFindings(storyId).findings || [];
  const prior = latestTrustedPriorPass(store, storyId, role, passes, runs, options.excludedReviewRunId);
  const currentHead = currentGitHead(projectRoot) ?? null;
  const currentMaterial = currentMaterialHash(projectRoot, 'HEAD', projectRoot) ?? null;
  const currentStoryFiles = currentStoryFilesHash(projectRoot, 'HEAD', projectRoot) ?? null;
  const checklist = store.readChecklist(storyId);
  const scopeContract = store.readScopeContract(storyId);
  const story = store.readStory(storyId);
  let currentTaskSemanticDigest: string | null = null;
  if (currentHead) {
    try {
      currentTaskSemanticDigest = fullTaskSemanticDigest(buildFullTaskContext({
        story,
        checklist,
        headHash: currentHead,
        materialHash: currentMaterial ?? undefined,
        storyFilesHash: currentStoryFiles ?? undefined,
        scopeContract,
      }));
    } catch {
      // Legacy/malformed task context is not eligible; the stable FULL reason is
      // added below instead of letting this advisory read throw.
    }
  }
  const declaredTestFiles = checklist.items.flatMap(item => item.files?.test ?? []);
  const testIntentRefsByFile = Object.fromEntries(declaredTestFiles.map(path => {
    const refs = checklist.items
      .filter(item => item.files?.test?.includes(path))
      .flatMap(item => (['happy', 'edge', 'adversarial'] as const)
        .flatMap(lane => (item.verificationIntent?.[lane] ?? [])
          .map((intent, index) => intent.id?.trim() || `${item.id}:${lane}:${index}`)));
    return [path, [...new Set(refs)].sort()];
  }));
  const currentStoryIntentRefs = new Set(checklist.items.flatMap(item =>
    (['happy', 'edge', 'adversarial'] as const).flatMap(lane =>
      (item.verificationIntent?.[lane] ?? []).map((_intent, index) =>
        `${storyId}:${item.id}:${lane}:${index}`))));

  const finalize = (args: {
    prior: TrustedPriorPass | null;
    changedFiles: string[];
    freshnessClassification: EvidenceFreshnessClassification | 'NOT_EVALUATED';
    reasonCodes: string[];
    impact: ImpactClassification;
  }): ReviewIncrementalContext => {
    const eligibilityReasonCodes = [...new Set([...args.reasonCodes, ...args.impact.reasonCodes])].sort();
    const contextMode = eligibilityReasonCodes.every(code => code.startsWith('ELIGIBLE_'))
      ? 'incremental' as const
      : 'full' as const;
    const changedFilesDigest = domainSeparatedDigest('incremental.changed-files.v1', args.changedFiles);
    const impactedFilesDigest = domainSeparatedDigest('incremental.impacted-files.v1', args.impact.impactedFiles);
    const affectedPaths = new Set([...args.changedFiles, ...args.impact.impactedFiles]);
    const affectedItems = checklist.items.filter(item => [
      ...(item.files?.modify ?? []),
      ...(item.files?.create ?? []),
      ...(item.files?.test ?? []),
    ].some(path => affectedPaths.has(path)));
    const impactedIntentRefs = affectedItems.flatMap(item =>
      (['happy', 'edge', 'adversarial'] as const).flatMap(lane =>
        (item.verificationIntent?.[lane] ?? []).map((intent, index) =>
          intent.id?.trim() || `${item.id}:${lane}:${index}`)));
    let reviewBasis: IncrementalReviewBasis | null = null;
    if (args.prior) {
      const priorTime = Date.parse(args.prior.pass.createdAt);
      const cutoff = options.findingsCutoffAt ? Date.parse(options.findingsCutoffAt) : Number.POSITIVE_INFINITY;
      const basisFindings = findings.filter(finding => {
        const created = Date.parse(finding.createdAt ?? '');
        return !Number.isFinite(cutoff) || (Number.isFinite(created) && created <= cutoff);
      });
      const findingDeltas = basisFindings
        .filter(finding => !Number.isFinite(priorTime) || Date.parse(finding.createdAt ?? '') >= priorTime)
        .map(finding => ({
          id: finding.id,
          state: finding.status,
          severity: finding.severity,
          category: finding.category,
        }))
        .sort((left, right) => left.id.localeCompare(right.id));
      const unresolvedFindings = basisFindings
        .filter(finding => finding.status === 'open')
        .map(finding => ({
          id: finding.id,
          severity: finding.severity,
          category: finding.category,
          desc: finding.desc,
        }))
        .sort((left, right) => left.id.localeCompare(right.id));
      const authoritativeReferences = [...new Set([
        ...affectedItems.flatMap(item => item.relatedDocs ?? []),
        ...args.changedFiles,
        ...args.impact.impactedFiles,
      ])].sort();
      reviewBasis = {
        schemaVersion: 'proofbound.incremental-review-basis.v1',
        storyId,
        lane: role,
        priorPassRef: args.prior.pass.id,
        priorReviewRunId: args.prior.run.reviewRunId,
        priorEnvelopeId: args.prior.run.envelopeId!,
        reReviewReasonCodes: eligibilityReasonCodes,
        changedFiles: [...args.changedFiles].sort(),
        impactedFiles: [...args.impact.impactedFiles].sort(),
        impactedIntentRefs: [...new Set(impactedIntentRefs)].sort(),
        currentClaims: affectedItems
          .flatMap(item => (['happy', 'edge', 'adversarial'] as const)
            .flatMap(lane => (item.verificationIntent?.[lane] ?? []).map((intent, index) => ({
              intentRef: intent.id?.trim() || `${item.id}:${lane}:${index}`,
              claim: intent.desc,
              state: item.status,
            }))))
          .sort((left, right) => left.intentRef.localeCompare(right.intentRef)),
        invariants: [
          'Reviewer evidence remains bound to the exact current Story, lane, round, ReviewRun, Prompt Envelope, and hashes.',
          'Missing or unclosed affected context escalates to full review.',
          'Authoritative repository-relative references remain readable on demand.',
        ],
        findingDeltas,
        unresolvedFindings,
        affectedContracts: args.impact.impacts
          .filter(impact => !['no-material-change', 'pure-story-fixture'].includes(impact.category))
          .map(impact => `${impact.category}:${impact.path}`)
          .sort(),
        authoritativeReferences,
        ...(scopeContract ? { scopeAcknowledgementDigest: digestScopeContract(scopeContract) } : {}),
      };
      validateIncrementalReviewBasis(reviewBasis);
    }
    const reviewBasisDigest = reviewBasis
      ? domainSeparatedDigest('incremental-review-basis.v1', reviewBasis)
      : null;
    const semantic = {
      impactPolicyVersion: IMPACT_CLASSIFICATION_POLICY_VERSION,
      role,
      contextMode,
      priorPassRef: args.prior?.pass.id ?? null,
      priorReviewRunId: args.prior?.run.reviewRunId ?? null,
      priorEnvelopeId: args.prior?.run.envelopeId ?? null,
      priorHeadHash: args.prior?.run.headHash ?? null,
      freshnessClassification: args.freshnessClassification,
      eligibilityReasonCodes,
      changedFilesDigest,
      impactedFilesDigest,
      impactDigest: args.impact.digest,
      reviewBasisDigest,
    };
    return {
      role,
      isFirstPass: !args.prior,
      priorHeadHash: args.prior?.run.headHash ?? null,
      priorVerdict: args.prior ? `PASS (${args.prior.pass.id})` : null,
      scopeChanged: !args.prior || args.changedFiles.length > 0,
      changedFiles: args.changedFiles,
      contextMode,
      impactPolicyVersion: IMPACT_CLASSIFICATION_POLICY_VERSION,
      freshnessClassification: args.freshnessClassification,
      eligibilityReasonCodes,
      eligibilityDigest: domainSeparatedDigest('incremental-eligibility.v1', semantic),
      impact: args.impact,
      priorPassRef: args.prior?.pass.id ?? null,
      priorReviewRunId: args.prior?.run.reviewRunId ?? null,
      currentHeadHash: currentHead,
      currentMaterialHash: currentMaterial,
      currentStoryFilesHash: currentStoryFiles,
      changedFilesDigest,
      impactedFiles: args.impact.impactedFiles,
      impactedFilesDigest,
      reviewBasis,
      reviewBasisDigest,
      taskSemanticDigest: currentTaskSemanticDigest,
    };
  };

  // First-timer (or a prior verdict whose bound headHash cannot be resolved):
  // fall back to the full story diff against main. We treat a missing bound
  // headHash as a first pass so we never compute an incremental diff from an
  // unknown base — the conservative direction is "show everything".
  if (!prior || !prior.run.headHash) {
    const fullDiff = materialOnly(changedFilesBetweenRenameAware(projectRoot, 'main', 'HEAD'), projectRoot);
    const impact = classifyImpact({
      changedFiles: fullDiff,
      declaredTestFiles,
      testIntentRefsByFile,
      fixtureCaseClosureByFile: Object.fromEntries(fullDiff.map(path => [
        path,
        declaredTestFiles.includes(path)
          && fixtureCaseClosure(projectRoot, 'main', storyId, path, currentStoryIntentRefs),
      ])),
      changedFileStatus: changedFileStatusesBetweenRenameAware(projectRoot, 'main', 'HEAD'),
    });
    return finalize({
      prior: null,
      changedFiles: fullDiff,
      freshnessClassification: 'NOT_EVALUATED',
      reasonCodes: ['FULL_MISSING_TRUSTED_PRIOR_PASS'],
      impact,
    });
  }

  const changedFiles = materialOnly(
    changedFilesBetweenRenameAware(projectRoot, prior.run.headHash, 'HEAD'),
    projectRoot,
  );
  const statuses = changedFileStatusesBetweenRenameAware(projectRoot, prior.run.headHash, 'HEAD');
  const freshness = checkEvidenceFreshnessForGit(
    projectRoot,
    prior.run.headHash,
    prior.run.materialHash,
    projectRoot,
    prior.run.storyFilesHash,
  );
  const freshnessClassification = classifyEvidenceFreshness(freshness, prior.run.headHash);
  const currentRole = promptRoleContract(role);
  const environmentDigest = domainSeparatedDigest('known-execution-environment.v1', captureKnownExecutionEnvironment());
  const priorEnvelope = store.readPromptEnvelopes(storyId).envelopes.find(
    envelope => envelope.envelopeId === prior.run.envelopeId,
  );
  const currentPolicyHash = scopeContract ? digestScopeContract(scopeContract) : undefined;
  const runtimeContractMatches = Boolean(priorEnvelope) && !(
    priorEnvelope?.runtimeContractVersion !== BASELINE_RUNTIME_CONTRACT.schemaVersion
    || priorEnvelope?.runtimeSemanticDigest !== BASELINE_RUNTIME_CONTRACT.semanticDigest
    || priorEnvelope?.runtimeRenderDigest !== BASELINE_RUNTIME_CONTRACT.renderDigest
  );
  const roleContractMatches = Boolean(priorEnvelope) && !(
    priorEnvelope?.roleContractVersion !== currentRole.schemaVersion
    || priorEnvelope?.roleSemanticDigest !== currentRole.semanticDigest
    || priorEnvelope?.roleRenderDigest !== currentRole.renderDigest
  );
  const impact = classifyImpact({
    changedFiles,
    declaredTestFiles,
    testIntentRefsByFile,
    fixtureCaseClosureByFile: Object.fromEntries(changedFiles.map(path => [
      path,
      declaredTestFiles.includes(path)
        && fixtureCaseClosure(projectRoot, prior.run.headHash, storyId, path, currentStoryIntentRefs),
    ])),
    changedFileStatus: statuses,
  });
  const pureFixtureDrift = freshnessClassification === 'RELATED_STORY_MATERIAL_DRIFT'
    && impact.eligible
    && impact.impacts.every(item => item.reasonCode === 'ELIGIBLE_PURE_STORY_FIXTURE')
    && Boolean(prior.run.storyFilesHash);
  const bindingReasons = classifyIncrementalBindingReasons({
    priorEnvelopePresent: Boolean(priorEnvelope),
    runtimeContractMatches,
    roleContractMatches,
    executionEnvironmentMatches: priorEnvelope?.knownExecutionEnvironmentDigest === environmentDigest,
    assemblerMatches: priorEnvelope?.assemblerVersion === PROMPT_ENVELOPE_ASSEMBLER_VERSION,
    dispatchProtocolMatches: priorEnvelope?.dispatchProtocolVersion === PROMPT_DISPATCH_PROTOCOL_VERSION,
    scopePolicyMatches: priorEnvelope?.policyHash === currentPolicyHash,
    taskSemanticDigestMatches: Boolean(priorEnvelope?.taskSemanticDigest)
      && priorEnvelope?.taskSemanticDigest === currentTaskSemanticDigest,
    freshnessClassification,
    pureFixtureDrift,
  });
  return finalize({
    prior,
    changedFiles,
    freshnessClassification,
    reasonCodes: bindingReasons,
    impact,
  });
}
