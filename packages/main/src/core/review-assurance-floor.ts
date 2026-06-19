import { execFileSync } from 'child_process';
import { currentMaterialHash, isMaterialExcludedPath } from './evidence-freshness.js';
import {
  evaluateHostVerdictRounds,
  type HostVerdictRound,
  type IgnoredHostVerdict,
} from './host-independence.js';
import { isReviewerAgent } from './review-run.js';
import type { BugData, Finding, ProcessEvent, StoryInfo, TestEvidenceData } from './types.js';
import type { StoryStore } from './store.js';

export const REVIEW_ASSURANCE_FLOOR_REQUIRED_ROUNDS = 1;
export const REVIEW_ASSURANCE_FLOOR_FAILURE_REQUIRED_ROUNDS = 3;
export const REVIEW_ASSURANCE_FLOOR_LOCAL_HOSTS_PER_ROUND = 1;

export type ReviewAssuranceFloorAssuranceLevel =
  | 'not-required'
  | 'local-one-round'
  | 'degraded-single-host'
  | 'missing';

export type ReviewAssuranceFloorRequiredAssurance =
  | 'none'
  | 'one-local-round'
  | 'three-local-rounds';

export interface ReviewAssuranceFloorChangedFile {
  path: string;
  materialCode: boolean;
  reason: string;
}

export interface ReviewAssuranceFloorFailureSignal {
  kind:
    | 'validation-failure'
    | 'bug'
    | 'bug-reopened'
    | 'verified-reviewer-finding'
    | 'repeated-rework';
  id?: string;
  detail: string;
}

export interface ReviewAssuranceFloorReport {
  schemaVersion: 'lattice.review_assurance_floor.v1';
  ok: boolean;
  required: boolean;
  requiredAssurance: ReviewAssuranceFloorRequiredAssurance;
  assuranceLevel: ReviewAssuranceFloorAssuranceLevel;
  materialHash: string | null;
  changedFiles: ReviewAssuranceFloorChangedFile[];
  materialCodePaths: string[];
  failureSignals: ReviewAssuranceFloorFailureSignal[];
  localRounds: {
    requiredRounds: number;
    requiredPassingHostsPerRound: number;
    ok: boolean;
    validRounds: HostVerdictRound[];
    invalidRounds: HostVerdictRound[];
    ignoredVerdicts: IgnoredHostVerdict[];
  };
  authorityDone: false;
  fullAuthorityDone: false;
  productionDone: false;
  reasons: string[];
  diffError?: string;
}

export interface EvaluateReviewAssuranceFloorArgs {
  projectRoot: string;
  gitCwd?: string;
  storyId?: string;
  store?: Pick<StoryStore, 'readStory' | 'readFindings' | 'readProcessEvents' | 'readBugs' | 'readTestEvidence'>;
  story?: StoryInfo;
  findings?: Finding[];
  processEvents?: ProcessEvent[];
  bugs?: BugData;
  testEvidence?: TestEvidenceData | null;
  changedFiles?: string[];
  materialHash?: string;
}

function normalizeString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, '/').replace(/^\.\/+/, '');
}

function fileName(path: string): string {
  const parts = normalizePath(path).split('/');
  return parts[parts.length - 1]?.toLowerCase() ?? '';
}

function hasExtension(path: string, extensions: readonly string[]): boolean {
  const lower = path.toLowerCase();
  return extensions.some(ext => lower.endsWith(ext));
}

function isPackageOrRuntimeConfigPath(path: string): boolean {
  const name = fileName(path);
  return (
    name === 'package.json' ||
    name === 'package-lock.json' ||
    name === 'pnpm-lock.yaml' ||
    name === 'yarn.lock' ||
    name === 'bun.lockb' ||
    name === 'tsconfig.json' ||
    name.startsWith('tsconfig.') ||
    name === 'lattice.config.json'
  );
}

export function classifyReviewAssuranceFloorPath(path: string, projectRoot?: string): ReviewAssuranceFloorChangedFile {
  const normalized = normalizePath(path);
  const lower = normalized.toLowerCase();

  if (!normalized) {
    return { path: normalized, materialCode: false, reason: 'empty path' };
  }
  if (isMaterialExcludedPath(normalized, projectRoot)) {
    return { path: normalized, materialCode: false, reason: 'lattice runtime/story metadata' };
  }
  if (hasExtension(lower, ['.md', '.mdx'])) {
    return { path: normalized, materialCode: false, reason: 'markdown documentation' };
  }
  if (
    lower.startsWith('packages/main/src/') ||
    lower.startsWith('packages/main/tests/') ||
    lower.startsWith('packages/main/test/') ||
    lower.startsWith('scripts/') ||
    lower.startsWith('bin/')
  ) {
    return { path: normalized, materialCode: true, reason: 'source/runtime/test/script path' };
  }
  if (isPackageOrRuntimeConfigPath(lower)) {
    return { path: normalized, materialCode: true, reason: 'package/runtime config path' };
  }
  if (hasExtension(lower, ['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.mjs', '.cjs', '.sh'])) {
    return { path: normalized, materialCode: true, reason: 'code or script extension' };
  }
  return { path: normalized, materialCode: false, reason: 'non-code project material' };
}

function listChangedFiles(gitCwd: string): { files: string[]; error?: string } {
  try {
    const raw = execFileSync('git', ['diff', '--name-only', 'main...HEAD'], {
      cwd: gitCwd,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    return { files: raw ? raw.split('\n').map(line => line.trim()).filter(Boolean) : [] };
  } catch (err) {
    return {
      files: [],
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function readStory(args: EvaluateReviewAssuranceFloorArgs): StoryInfo | null {
  if (args.story) return args.story;
  if (!args.store || !args.storyId) return null;
  return args.store.readStory(args.storyId);
}

function readFindings(args: EvaluateReviewAssuranceFloorArgs): Finding[] {
  if (args.findings) return args.findings;
  if (!args.store || !args.storyId) return [];
  return args.store.readFindings(args.storyId).findings;
}

function readEvents(args: EvaluateReviewAssuranceFloorArgs): ProcessEvent[] {
  if (args.processEvents) return args.processEvents;
  if (!args.store || !args.storyId) return [];
  return args.store.readProcessEvents(args.storyId);
}

function readBugs(args: EvaluateReviewAssuranceFloorArgs): BugData {
  if (args.bugs) return args.bugs;
  if (!args.store || !args.storyId) return { bugs: [] };
  return args.store.readBugs(args.storyId);
}

function readTestEvidence(args: EvaluateReviewAssuranceFloorArgs): TestEvidenceData | null {
  if (args.testEvidence !== undefined) return args.testEvidence;
  if (!args.store || !args.storyId) return null;
  return args.store.readTestEvidence(args.storyId);
}

function isVerifiedReviewerFinding(finding: Finding): boolean {
  if (!isReviewerAgent(finding.agent)) return false;
  if (finding.evidenceState === 'suspected' || finding.evidenceState === 'disproven') return false;
  if (finding.evidenceState && finding.evidenceState !== 'verified') return false;
  return true;
}

function collectFailureSignals(args: EvaluateReviewAssuranceFloorArgs): ReviewAssuranceFloorFailureSignal[] {
  const signals: ReviewAssuranceFloorFailureSignal[] = [];
  const testEvidence = readTestEvidence(args);
  if (testEvidence?.result === 'FAIL') {
    signals.push({
      kind: 'validation-failure',
      detail: `test-evidence.json result=${testEvidence.result}`,
    });
  }

  for (const bug of readBugs(args).bugs) {
    signals.push({
      kind: 'bug',
      id: bug.id,
      detail: `${bug.id} status=${bug.status}`,
    });
  }

  for (const finding of readFindings(args).filter(isVerifiedReviewerFinding)) {
    signals.push({
      kind: 'verified-reviewer-finding',
      id: finding.id,
      detail: `${finding.id} ${finding.severity} status=${finding.status}`,
    });
  }

  for (const event of readEvents(args)) {
    const type = normalizeString(event.type);
    if (type === 'bug_reopened') {
      signals.push({
        kind: 'bug-reopened',
        id: normalizeString(event.bugId) || undefined,
        detail: `bug_reopened${normalizeString(event.bugId) ? ` ${normalizeString(event.bugId)}` : ''}`,
      });
    }
    const result = normalizeString(event.result).toLowerCase();
    const command = normalizeString(event.command).toLowerCase();
    if ((result === 'fail' || result === 'failed') && /validate|validation/.test(`${type} ${command}`)) {
      signals.push({
        kind: 'validation-failure',
        detail: `${type || 'process-event'} result=${result}`,
      });
    }
  }

  const story = readStory(args);
  const devAdvances = (story?.events ?? []).filter(event => event.phase === 'DEV' && event.action === 'advance');
  if (devAdvances.length > 1) {
    signals.push({
      kind: 'repeated-rework',
      detail: `${devAdvances.length} DEV advance events`,
    });
  }

  return signals;
}

function emptyRounds(requiredRounds: number) {
  return {
    requiredRounds,
    requiredPassingHostsPerRound: REVIEW_ASSURANCE_FLOOR_LOCAL_HOSTS_PER_ROUND,
    ok: requiredRounds === 0,
    validRounds: [],
    invalidRounds: [],
    ignoredVerdicts: [],
  };
}

function reportBase(
  overrides: Partial<ReviewAssuranceFloorReport>,
): ReviewAssuranceFloorReport {
  return {
    schemaVersion: 'lattice.review_assurance_floor.v1',
    ok: true,
    required: false,
    requiredAssurance: 'none',
    assuranceLevel: 'not-required',
    materialHash: null,
    changedFiles: [],
    materialCodePaths: [],
    failureSignals: [],
    localRounds: emptyRounds(0),
    authorityDone: false,
    fullAuthorityDone: false,
    productionDone: false,
    reasons: [],
    ...overrides,
  };
}

export function evaluateReviewAssuranceFloor(args: EvaluateReviewAssuranceFloorArgs): ReviewAssuranceFloorReport {
  const gitCwd = args.gitCwd ?? args.projectRoot;
  const listed = args.changedFiles ? { files: args.changedFiles } : listChangedFiles(gitCwd);
  const changedFiles = listed.files.map(path => classifyReviewAssuranceFloorPath(path, args.projectRoot));
  const materialCodePaths = changedFiles
    .filter(file => file.materialCode)
    .map(file => file.path);
  const materialHash = args.materialHash ?? currentMaterialHash(gitCwd, 'HEAD', args.projectRoot) ?? null;
  const failureSignals = collectFailureSignals(args);

  if (listed.error) {
    return reportBase({
      ok: false,
      required: true,
      requiredAssurance: 'one-local-round',
      assuranceLevel: 'missing',
      materialHash,
      changedFiles,
      materialCodePaths,
      failureSignals,
      localRounds: emptyRounds(REVIEW_ASSURANCE_FLOOR_REQUIRED_ROUNDS),
      reasons: [`unable to classify git diff against main: ${listed.error}`],
      diffError: listed.error,
    });
  }

  if (materialCodePaths.length === 0) {
    return reportBase({
      changedFiles,
      materialHash,
      failureSignals,
      reasons: [],
    });
  }

  const requiredRounds = failureSignals.length > 0
    ? REVIEW_ASSURANCE_FLOOR_FAILURE_REQUIRED_ROUNDS
    : REVIEW_ASSURANCE_FLOOR_REQUIRED_ROUNDS;
  const requiredAssurance: ReviewAssuranceFloorRequiredAssurance = requiredRounds === REVIEW_ASSURANCE_FLOOR_FAILURE_REQUIRED_ROUNDS
    ? 'three-local-rounds'
    : 'one-local-round';

  if (!materialHash) {
    return reportBase({
      ok: false,
      required: true,
      requiredAssurance,
      assuranceLevel: 'missing',
      materialHash: null,
      changedFiles,
      materialCodePaths,
      failureSignals,
      localRounds: emptyRounds(requiredRounds),
      reasons: ['current material hash is unavailable'],
    });
  }

  const localRounds = evaluateHostVerdictRounds(
    readEvents(args),
    materialHash,
    REVIEW_ASSURANCE_FLOOR_LOCAL_HOSTS_PER_ROUND,
  );
  const ok = localRounds.validRounds.length >= requiredRounds;
  const reasons: string[] = [];
  if (!ok) {
    reasons.push(
      `review assurance floor requires ${requiredRounds} fresh local PASS round(s) over current material; found ${localRounds.validRounds.length}`,
    );
    if (failureSignals.length > 0) {
      reasons.push(`failure signals make the 3x1 local floor sticky: ${failureSignals.map(signal => signal.kind).join(', ')}`);
    }
  }

  return {
    schemaVersion: 'lattice.review_assurance_floor.v1',
    ok,
    required: true,
    requiredAssurance,
    assuranceLevel: ok
      ? (requiredRounds === REVIEW_ASSURANCE_FLOOR_FAILURE_REQUIRED_ROUNDS ? 'degraded-single-host' : 'local-one-round')
      : 'missing',
    materialHash,
    changedFiles,
    materialCodePaths,
    failureSignals,
    localRounds: {
      requiredRounds,
      requiredPassingHostsPerRound: REVIEW_ASSURANCE_FLOOR_LOCAL_HOSTS_PER_ROUND,
      ok,
      ...localRounds,
    },
    authorityDone: false,
    fullAuthorityDone: false,
    productionDone: false,
    reasons,
  };
}

export function formatReviewAssuranceFloorFailure(report: ReviewAssuranceFloorReport): string {
  if (report.ok) return '';
  const signalSummary = report.failureSignals.length > 0
    ? report.failureSignals.map(signal => `${signal.kind}${signal.id ? `:${signal.id}` : ''}`).join(', ')
    : 'none';
  const lines = [
    'Cannot enter DONE: material code diff requires review assurance floor. [review_assurance_floor_missing]',
    `  - required assurance: ${report.requiredAssurance}`,
    `  - assuranceLevel: ${report.assuranceLevel}`,
    `  - materialHash: ${report.materialHash ?? '<missing>'}`,
    `  - material code paths: ${report.materialCodePaths.length === 0 ? '<unknown>' : report.materialCodePaths.slice(0, 8).join(', ')}`,
    `  - local rounds: ${report.localRounds.validRounds.length}/${report.localRounds.requiredRounds} with ${report.localRounds.requiredPassingHostsPerRound} PASS host`,
    `  - failure signals: ${signalSummary}`,
  ];
  for (const round of report.localRounds.invalidRounds.slice(0, 5)) {
    lines.push(`  - invalid local round ${round.runId}: ${round.reasons.join('; ')}`);
  }
  for (const ignored of report.localRounds.ignoredVerdicts.slice(0, 8)) {
    const id = ignored.verdictId ?? `event#${ignored.index}`;
    lines.push(`  - ignored host verdict ${id}: ${ignored.reasons.join('; ')}`);
  }
  for (const reason of report.reasons) {
    lines.push(`  - ${reason}`);
  }
  lines.push('→ Submit fresh local host verdicts with autopilot_review_submit over the current material hash; failure-signal stories need 3 local single-host rounds.');
  return lines.join('\n');
}
