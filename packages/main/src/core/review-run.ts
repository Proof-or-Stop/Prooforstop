import { createHash } from 'crypto';
import { checkEvidenceFreshnessForGit, currentGitHead, currentMaterialHash } from './evidence-freshness.js';
import { verifyFinding, verifyReviewPass } from './finding-verify.js';
import type { Finding, ReviewPass, ReviewRun, StoryInfo } from './types.js';
import type { StoryStore } from './store.js';

export const REVIEW_RUN_SALT = 'koala-review-run-integrity-v1';

export const REVIEW_RUN_LANES = [
  'koala-review-concept',
  'koala-review-quality',
  'koala-review-test-coverage',
  'koala-review-behavior',
  'koala-review-docs',
  'koala-review-channel',
] as const;

export type ReviewRunLane = typeof REVIEW_RUN_LANES[number];
export type ReviewEvidenceKind = 'finding' | 'pass';
export type ReviewRunIssueCode =
  | 'missing_review_run_id'
  | 'invalid_evidence_signature'
  | 'unknown_run'
  | 'invalid_run_signature'
  | 'wrong_lane'
  | 'wrong_round'
  | 'stale_run'
  | 'stale_run_hash';

export interface ReviewRunIssue {
  code: ReviewRunIssueCode;
  kind: ReviewEvidenceKind;
  evidenceId: string;
  agent: string;
  reviewRunId?: string;
  message: string;
}

export interface ReviewerEvidenceRecord {
  id: string;
  kind: ReviewEvidenceKind;
  agent: string;
  reviewRound?: string;
  reviewRunId?: string;
  signatureValid?: boolean;
  finding?: Finding;
  pass?: ReviewPass;
}

export interface ReviewerEvidenceState {
  valid: ReviewerEvidenceRecord[];
  invalid: ReviewRunIssue[];
}

export function isReviewRunLane(value: string): value is ReviewRunLane {
  return (REVIEW_RUN_LANES as readonly string[]).includes(value);
}

export function resolveReviewRunLane(agent?: string, lane?: string): ReviewRunLane {
  const resolvedAgent = (agent || '').trim();
  const resolvedLane = (lane || '').trim();
  const candidate = resolvedLane || resolvedAgent;
  if (!candidate) {
    throw new Error(`review_run_start: agent/lane 必须提供一个有效的 koala-review-* reviewer（支持: ${REVIEW_RUN_LANES.join(', ')}）`);
  }
  if (resolvedAgent && !resolvedAgent.startsWith('koala-review-')) {
    throw new Error(`review_run_start: agent "${resolvedAgent}" 不是 koala-review-* reviewer`);
  }
  if (!isReviewRunLane(candidate)) {
    throw new Error(`review_run_start: lane "${candidate}" 不在受支持的 REVIEW reviewer lane 列表中（支持: ${REVIEW_RUN_LANES.join(', ')}）`);
  }
  if (resolvedAgent && resolvedLane && resolvedAgent !== resolvedLane) {
    throw new Error(`review_run_start: agent "${resolvedAgent}" 与 lane "${resolvedLane}" 不一致`);
  }
  return candidate;
}

export function hashReviewPrompt(prompt: string): string {
  return createHash('sha256').update(prompt).digest('hex');
}

export function resolveReviewPromptHash(prompt?: string, promptHash?: string): string {
  const trimmedPromptHash = promptHash?.trim() || '';
  const trimmedPrompt = prompt?.trim() || '';
  if (!trimmedPrompt) return trimmedPromptHash;
  const computed = hashReviewPrompt(trimmedPrompt);
  if (trimmedPromptHash && trimmedPromptHash !== computed) {
    throw new Error('review_run_start: promptHash 与 prompt 实际 sha256 不一致');
  }
  return computed;
}

export function captureReviewRunSnapshot(projectRoot: string): { headHash: string; materialHash: string } {
  const headHash = currentGitHead(projectRoot) || '';
  const materialHash = currentMaterialHash(projectRoot) || '';
  if (!headHash || !materialHash) {
    throw new Error('review_run_start: 无法捕获当前 git HEAD/materialHash，请在 story worktree 中执行');
  }
  return { headHash, materialHash };
}

export function signReviewRun(
  storyId: string,
  reviewRunId: string,
  agent: string,
  lane: string,
  reviewRound: string,
  startedAt: string,
  headHash: string,
  materialHash: string,
  promptHash: string,
): string {
  return createHash('sha256')
    .update([
      storyId,
      reviewRunId,
      agent,
      lane,
      reviewRound,
      startedAt,
      headHash,
      materialHash,
      promptHash,
      REVIEW_RUN_SALT,
    ].join(':'))
    .digest('hex');
}

export function verifyReviewRun(run: ReviewRun): boolean {
  if (
    !run._hash || !run.storyId || !run.reviewRunId || !run.agent || !run.lane
    || !run.reviewRound || !run.startedAt || !run.headHash || !run.materialHash
  ) {
    return false;
  }
  const expected = signReviewRun(
    run.storyId,
    run.reviewRunId,
    run.agent,
    run.lane,
    run.reviewRound,
    run.startedAt,
    run.headHash,
    run.materialHash,
    run.promptHash || '',
  );
  return run._hash === expected;
}

function compareRunRecency(a: ReviewRun, b: ReviewRun): number {
  const aTime = Date.parse(a.startedAt);
  const bTime = Date.parse(b.startedAt);
  if (Number.isNaN(aTime) || Number.isNaN(bTime)) {
    return a.reviewRunId.localeCompare(b.reviewRunId);
  }
  return aTime - bTime;
}

function currentRunForLane(runs: ReviewRun[], lane: string, reviewRound: string): ReviewRun | null {
  const current = runs
    .filter(run => verifyReviewRun(run) && run.lane === lane && run.reviewRound === reviewRound)
    .sort(compareRunRecency);
  return current.length > 0 ? current[current.length - 1] : null;
}

function rerunHint(storyId: string, lane: string): string {
  return `→ 重新执行 koala review_run_start '{"storyId":"${storyId}","agent":"${lane}"}'，然后用新的 reviewRunId 重提 finding_add/review_pass_set`;
}

export function assertCurrentReviewRunForEvidence(
  store: StoryStore,
  story: StoryInfo,
  projectRoot: string,
  agent: string,
  reviewRunId: string | undefined,
): ReviewRun {
  if (!story.currentReviewRound) {
    throw new Error(`review_run_start: story ${story.storyId} 当前没有 currentReviewRound；先推进到 REVIEW 再启动 reviewer run`);
  }
  if (!reviewRunId || !reviewRunId.trim()) {
    throw new Error(`review evidence for ${agent} 缺少 reviewRunId。 ${rerunHint(story.storyId, agent)}`);
  }
  const runs = store.readReviewRuns(story.storyId).runs;
  const run = runs.find((candidate) => candidate.reviewRunId === reviewRunId);
  if (!run) {
    throw new Error(`review evidence for ${agent} 引用了未知的 reviewRunId ${reviewRunId}。 ${rerunHint(story.storyId, agent)}`);
  }
  if (!verifyReviewRun(run)) {
    throw new Error(`review evidence for ${agent} 绑定的 reviewRunId ${reviewRunId} 签名无效。 ${rerunHint(story.storyId, agent)}`);
  }
  if (run.lane !== agent) {
    throw new Error(`review evidence agent=${agent} 与 reviewRunId ${reviewRunId} 的 lane=${run.lane} 不匹配。 ${rerunHint(story.storyId, agent)}`);
  }
  if (run.reviewRound !== story.currentReviewRound) {
    throw new Error(`review evidence for ${agent} 绑定的 reviewRunId ${reviewRunId} 属于 reviewRound ${run.reviewRound}，当前 round 是 ${story.currentReviewRound}。 ${rerunHint(story.storyId, agent)}`);
  }
  const currentRun = currentRunForLane(runs, agent, story.currentReviewRound);
  if (currentRun && currentRun.reviewRunId !== reviewRunId) {
    throw new Error(`review evidence for ${agent} 绑定的 reviewRunId ${reviewRunId} 不是当前最新 reviewer run（当前: ${currentRun.reviewRunId}）。 ${rerunHint(story.storyId, agent)}`);
  }
  const freshness = checkEvidenceFreshnessForGit(projectRoot, run.headHash, run.materialHash);
  if (!freshness.fresh) {
    throw new Error(`review evidence for ${agent} 绑定的 reviewRunId ${reviewRunId} 已 stale：${freshness.reason}. ${rerunHint(story.storyId, agent)}`);
  }
  return run;
}

function validateEvidenceRunBinding(
  story: StoryInfo,
  projectRoot: string,
  runs: ReviewRun[],
  evidence: ReviewerEvidenceRecord,
): ReviewRunIssue | null {
  if (!story.currentReviewRound) return null;
  if (evidence.reviewRound !== story.currentReviewRound) {
    return {
      code: 'wrong_round',
      kind: evidence.kind,
      evidenceId: evidence.id,
      agent: evidence.agent,
      reviewRunId: evidence.reviewRunId,
      message: `${evidence.kind} ${evidence.id} 属于 reviewRound ${evidence.reviewRound || '缺失'}，当前 round 是 ${story.currentReviewRound}。 ${rerunHint(story.storyId, evidence.agent)}`,
    };
  }
  if (evidence.signatureValid === false) {
    return {
      code: 'invalid_evidence_signature',
      kind: evidence.kind,
      evidenceId: evidence.id,
      agent: evidence.agent,
      reviewRunId: evidence.reviewRunId,
      message: `${evidence.kind} ${evidence.id} 签名无效或记录被篡改；带 reviewRunId 的 REVIEW 证据必须使用包含 reviewRunId 的签名。 ${rerunHint(story.storyId, evidence.agent)}`,
    };
  }
  if (!evidence.reviewRunId) {
    return {
      code: 'missing_review_run_id',
      kind: evidence.kind,
      evidenceId: evidence.id,
      agent: evidence.agent,
      message: `${evidence.kind} ${evidence.id} 缺少 reviewRunId，当前 REVIEW 轮的 reviewer 证据必须绑定 review_run_start。 ${rerunHint(story.storyId, evidence.agent)}`,
    };
  }
  const run = runs.find(candidate => candidate.reviewRunId === evidence.reviewRunId);
  if (!run) {
    return {
      code: 'unknown_run',
      kind: evidence.kind,
      evidenceId: evidence.id,
      agent: evidence.agent,
      reviewRunId: evidence.reviewRunId,
      message: `${evidence.kind} ${evidence.id} 引用了未知的 reviewRunId ${evidence.reviewRunId}。 ${rerunHint(story.storyId, evidence.agent)}`,
    };
  }
  if (!verifyReviewRun(run)) {
    return {
      code: 'invalid_run_signature',
      kind: evidence.kind,
      evidenceId: evidence.id,
      agent: evidence.agent,
      reviewRunId: evidence.reviewRunId,
      message: `${evidence.kind} ${evidence.id} 绑定的 reviewRunId ${evidence.reviewRunId} 签名无效或记录被篡改。 ${rerunHint(story.storyId, evidence.agent)}`,
    };
  }
  if (run.lane !== evidence.agent) {
    return {
      code: 'wrong_lane',
      kind: evidence.kind,
      evidenceId: evidence.id,
      agent: evidence.agent,
      reviewRunId: evidence.reviewRunId,
      message: `${evidence.kind} ${evidence.id} 的 agent=${evidence.agent}，但 reviewRunId ${evidence.reviewRunId} 属于 lane=${run.lane}。 ${rerunHint(story.storyId, evidence.agent)}`,
    };
  }
  if (run.reviewRound !== story.currentReviewRound) {
    return {
      code: 'wrong_round',
      kind: evidence.kind,
      evidenceId: evidence.id,
      agent: evidence.agent,
      reviewRunId: evidence.reviewRunId,
      message: `${evidence.kind} ${evidence.id} 的 reviewRunId ${evidence.reviewRunId} 属于 reviewRound ${run.reviewRound}，当前 round 是 ${story.currentReviewRound}。 ${rerunHint(story.storyId, evidence.agent)}`,
    };
  }
  const currentRun = currentRunForLane(runs, evidence.agent, story.currentReviewRound);
  if (currentRun && currentRun.reviewRunId !== run.reviewRunId) {
    return {
      code: 'stale_run',
      kind: evidence.kind,
      evidenceId: evidence.id,
      agent: evidence.agent,
      reviewRunId: evidence.reviewRunId,
      message: `${evidence.kind} ${evidence.id} 绑定的 reviewRunId ${evidence.reviewRunId} 不是当前 lane 最新 run（当前: ${currentRun.reviewRunId}）。 ${rerunHint(story.storyId, evidence.agent)}`,
    };
  }
  const freshness = checkEvidenceFreshnessForGit(projectRoot, run.headHash, run.materialHash);
  if (!freshness.fresh) {
    return {
      code: 'stale_run_hash',
      kind: evidence.kind,
      evidenceId: evidence.id,
      agent: evidence.agent,
      reviewRunId: evidence.reviewRunId,
      message: `${evidence.kind} ${evidence.id} 绑定的 reviewRunId ${evidence.reviewRunId} 已 stale：${freshness.reason}. ${rerunHint(story.storyId, evidence.agent)}`,
    };
  }
  return null;
}

export function collectReviewerEvidenceState(
  store: StoryStore,
  storyId: string,
  projectRoot: string,
): ReviewerEvidenceState {
  const story = store.readStory(storyId);
  const currentRound = story.currentReviewRound;
  const runs = store.readReviewRuns(storyId).runs;
  const findings = store.readFindings(storyId).findings || [];
  const passes = store.readReviewPasses(storyId).passes || [];

  const reviewerFindings = findings
    .filter((finding) => finding.agent && finding.agent !== 'main')
    .filter((finding) => !currentRound || finding.reviewRound === currentRound || !finding.reviewRound)
    .map((finding) => ({
      id: finding.id,
      kind: 'finding' as const,
      agent: finding.agent!,
      reviewRound: finding.reviewRound,
      reviewRunId: finding.reviewRunId,
      signatureValid: verifyFinding(storyId, finding),
      finding,
    }));
  const reviewerPasses = passes
    .filter((pass) => pass.agent && pass.agent !== 'main')
    .filter((pass) => !currentRound || pass.reviewRound === currentRound || !pass.reviewRound)
    .map((pass) => ({
      id: pass.id,
      kind: 'pass' as const,
      agent: pass.agent,
      reviewRound: pass.reviewRound,
      reviewRunId: pass.reviewRunId,
      signatureValid: verifyReviewPass(storyId, pass),
      pass,
    }));

  const valid: ReviewerEvidenceRecord[] = [];
  const invalid: ReviewRunIssue[] = [];

  for (const evidence of [...reviewerFindings, ...reviewerPasses]) {
    const issue = validateEvidenceRunBinding(story, projectRoot, runs, evidence);
    if (issue) {
      invalid.push(issue);
    } else {
      valid.push(evidence);
    }
  }

  return { valid, invalid };
}
