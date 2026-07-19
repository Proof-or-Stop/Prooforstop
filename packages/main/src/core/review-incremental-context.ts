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
import { verifyReviewRun, verifyReviewRunPromptEnvelope } from './review-run.js';
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
  captureKnownExecutionEnvironment,
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
}

interface TrustedPriorPass {
  pass: ReviewPass;
  run: ReviewRun;
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
): TrustedPriorPass | null {
  const candidates: TrustedPriorPass[] = [];
  for (const pass of passes) {
    if (pass.agent !== role || !verifyReviewPass(storyId, pass) || !pass.reviewRunId) continue;
    const run = runs.find(candidate => candidate.reviewRunId === pass.reviewRunId);
    if (!run || run.lane !== role || !verifyReviewRun(run)) continue;
    if (!run.envelopeId || pass.envelopeId !== run.envelopeId) continue;
    if (!verifyReviewRunPromptEnvelope(store, run).ok) continue;
    candidates.push({ pass, run });
  }
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => verdictTime(a.pass.createdAt) - verdictTime(b.pass.createdAt));
  return candidates[candidates.length - 1];
}

function materialOnly(files: string[], projectRoot: string): string[] {
  return files.filter((file) => !isMaterialExcludedPath(file, projectRoot));
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
): ReviewIncrementalContext {
  const passes = store.readReviewPasses(storyId).passes || [];
  const runs = store.readReviewRuns(storyId).runs || [];
  const findings = store.readFindings(storyId).findings || [];
  const prior = latestTrustedPriorPass(store, storyId, role, passes, runs);
  const currentHead = currentGitHead(projectRoot) ?? null;
  const currentMaterial = currentMaterialHash(projectRoot, 'HEAD', projectRoot) ?? null;
  const currentStoryFiles = currentStoryFilesHash(projectRoot, 'HEAD', projectRoot) ?? null;
  const checklist = store.readChecklist(storyId);
  const scopeContract = store.readScopeContract(storyId);
  const declaredTestFiles = checklist.items.flatMap(item => item.files?.test ?? []);
  const testIntentRefsByFile = Object.fromEntries(declaredTestFiles.map(path => {
    const refs = checklist.items
      .filter(item => item.files?.test?.includes(path))
      .flatMap(item => (['happy', 'edge', 'adversarial'] as const)
        .flatMap(lane => (item.verificationIntent?.[lane] ?? [])
          .map((intent, index) => intent.id?.trim() || `${item.id}:${lane}:${index}`)));
    return [path, [...new Set(refs)].sort()];
  }));

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
      const findingDeltas = findings
        .filter(finding => !Number.isFinite(priorTime) || Date.parse(finding.createdAt ?? '') >= priorTime)
        .map(finding => ({
          id: finding.id,
          state: finding.status,
          severity: finding.severity,
          category: finding.category,
        }))
        .sort((left, right) => left.id.localeCompare(right.id));
      const unresolvedFindings = findings
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
      currentHeadHash: currentHead,
      currentMaterialHash: currentMaterial,
      currentStoryFilesHash: currentStoryFiles,
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
  const bindingReasons: string[] = [];
  if (!priorEnvelope) bindingReasons.push('FULL_MISSING_PRIOR_ENVELOPE');
  if (priorEnvelope && (
    priorEnvelope.runtimeContractVersion !== BASELINE_RUNTIME_CONTRACT.schemaVersion
    || priorEnvelope.runtimeSemanticDigest !== BASELINE_RUNTIME_CONTRACT.semanticDigest
    || priorEnvelope.runtimeRenderDigest !== BASELINE_RUNTIME_CONTRACT.renderDigest
  )) bindingReasons.push('FULL_RUNTIME_CONTRACT_CHANGED');
  if (priorEnvelope && (
    priorEnvelope.roleContractVersion !== currentRole.schemaVersion
    || priorEnvelope.roleSemanticDigest !== currentRole.semanticDigest
    || priorEnvelope.roleRenderDigest !== currentRole.renderDigest
  )) bindingReasons.push('FULL_ROLE_CONTRACT_CHANGED');
  if (priorEnvelope?.knownExecutionEnvironmentDigest !== environmentDigest) {
    bindingReasons.push('FULL_EXECUTION_ENVIRONMENT_CHANGED');
  }
  if (priorEnvelope?.assemblerVersion !== PROMPT_ENVELOPE_ASSEMBLER_VERSION) {
    bindingReasons.push('FULL_ASSEMBLER_CHANGED');
  }
  if (priorEnvelope?.dispatchProtocolVersion !== PROMPT_DISPATCH_PROTOCOL_VERSION) {
    bindingReasons.push('FULL_DISPATCH_PROTOCOL_CHANGED');
  }
  if (priorEnvelope?.policyHash !== currentPolicyHash) bindingReasons.push('FULL_SCOPE_OR_POLICY_CHANGED');
  if (!['CURRENT_MATERIAL', 'KNOWN_METADATA_ONLY_HEAD_DRIFT'].includes(freshnessClassification)) {
    bindingReasons.push(`FULL_FRESHNESS_${freshnessClassification}`);
  } else {
    bindingReasons.push('ELIGIBLE_TRUSTED_PRIOR_BINDINGS');
  }
  const impact = classifyImpact({
    changedFiles,
    declaredTestFiles,
    testIntentRefsByFile,
    changedFileStatus: statuses,
  });
  return finalize({
    prior,
    changedFiles,
    freshnessClassification,
    reasonCodes: bindingReasons,
    impact,
  });
}
