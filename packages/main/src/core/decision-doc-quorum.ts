import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { StoryStore } from './store.js';
import type { ProcessEvent } from './types.js';

const DECISION_DOC_PREFIX = 'docs/requirements/decisions/';
const REQUIRED_ROUNDS = 3;
const REQUIRED_PASSING_HOSTS_PER_ROUND = 2;

export interface DecisionDocChangedFile {
  path: string;
  status: string;
}

export interface DecisionDocQuorumRound {
  runId: string;
  passingHostIds: string[];
  passingVerdictIds: string[];
  reasons: string[];
}

export interface IgnoredDecisionDocVerdict {
  index: number;
  type: string;
  verdictId?: string;
  runId?: string;
  hostId?: string;
  decision?: string;
  materialDigest?: string;
  reasons: string[];
}

export interface DecisionDocQuorumReport {
  ok: boolean;
  applicable: boolean;
  materialDigest: string | null;
  changedFiles: DecisionDocChangedFile[];
  validRounds: DecisionDocQuorumRound[];
  invalidRounds: DecisionDocQuorumRound[];
  missing: {
    requiredRounds: number;
    requiredPassingHostsPerRound: number;
    validRounds: number;
    rounds: number;
    hostsByRound: Array<{ runId: string; passingHosts: number; missingHosts: number }>;
  };
  ignoredVerdicts: IgnoredDecisionDocVerdict[];
  diffError?: string;
}

export interface EvaluateDecisionDocQuorumArgs {
  projectRoot: string;
  storyId?: string;
  store?: Pick<StoryStore, 'readProcessEvents'>;
  processEvents?: ProcessEvent[];
  baseRef?: string;
  headRef?: string;
  changedFiles?: DecisionDocChangedFile[] | string[];
  materialDigest?: string;
}

function uniqueSorted(values: Iterable<string>): string[] {
  return [...new Set([...values].filter(Boolean))].sort();
}

function normalizeString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeHostId(value: unknown): string {
  return normalizeString(value).toLowerCase();
}

function isDirectDecisionDoc(path: string): boolean {
  if (!path.startsWith(DECISION_DOC_PREFIX) || !path.endsWith('.md')) return false;
  const rest = path.slice(DECISION_DOC_PREFIX.length);
  return rest.length > 0 && !rest.includes('/');
}

function git(gitCwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd: gitCwd,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
}

function normalizeChangedFiles(input: DecisionDocChangedFile[] | string[]): DecisionDocChangedFile[] {
  const files = input.map((entry) => {
    if (typeof entry === 'string') return { path: entry, status: 'M' };
    return { path: entry.path, status: entry.status || 'M' };
  });
  return files
    .filter(file => isDirectDecisionDoc(file.path))
    .sort((a, b) => a.path.localeCompare(b.path) || a.status.localeCompare(b.status));
}

export function listChangedDecisionDocs(projectRoot: string, baseRef = 'main', headRef = 'HEAD'): DecisionDocChangedFile[] {
  const raw = git(projectRoot, [
    'diff',
    '--name-status',
    '-z',
    '--diff-filter=ACMRD',
    `${baseRef}...${headRef}`,
    '--',
    DECISION_DOC_PREFIX,
  ]);
  if (!raw) return [];
  const parts = raw.split('\0').filter(Boolean);
  const files: DecisionDocChangedFile[] = [];
  for (let i = 0; i < parts.length;) {
    const status = parts[i++] ?? '';
    if (!status) continue;
    if (status.startsWith('R') || status.startsWith('C')) {
      i++; // old path
    }
    const path = parts[i++] ?? '';
    if (isDirectDecisionDoc(path)) files.push({ path, status });
  }
  return normalizeChangedFiles(files);
}

function objectIdFor(projectRoot: string, ref: string, file: DecisionDocChangedFile): string | null {
  if (file.status.startsWith('D')) return null;
  try {
    return git(projectRoot, ['rev-parse', `${ref}:${file.path}`]);
  } catch {
    const absolute = join(projectRoot, file.path);
    if (!existsSync(absolute)) return null;
    return createHash('sha256').update(readFileSync(absolute)).digest('hex');
  }
}

export function computeDecisionDocMaterialDigest(
  projectRoot: string,
  changedFiles: DecisionDocChangedFile[],
  headRef = 'HEAD',
): string {
  const entries = normalizeChangedFiles(changedFiles).map(file => ({
    path: file.path,
    status: file.status.slice(0, 1) || 'M',
    objectId: objectIdFor(projectRoot, headRef, file),
  }));
  return createHash('sha256').update(JSON.stringify(entries)).digest('hex');
}

function readEvents(args: EvaluateDecisionDocQuorumArgs): ProcessEvent[] {
  if (args.processEvents) return args.processEvents;
  if (!args.store || !args.storyId) return [];
  return args.store.readProcessEvents(args.storyId);
}

function emptyReport(overrides: Partial<DecisionDocQuorumReport>): DecisionDocQuorumReport {
  return {
    ok: true,
    applicable: false,
    materialDigest: null,
    changedFiles: [],
    validRounds: [],
    invalidRounds: [],
    missing: {
      requiredRounds: REQUIRED_ROUNDS,
      requiredPassingHostsPerRound: REQUIRED_PASSING_HOSTS_PER_ROUND,
      validRounds: 0,
      rounds: 0,
      hostsByRound: [],
    },
    ignoredVerdicts: [],
    ...overrides,
  };
}

export function evaluateDecisionDocQuorum(args: EvaluateDecisionDocQuorumArgs): DecisionDocQuorumReport {
  let changedFiles: DecisionDocChangedFile[];
  try {
    changedFiles = args.changedFiles
      ? normalizeChangedFiles(args.changedFiles)
      : listChangedDecisionDocs(args.projectRoot, args.baseRef, args.headRef);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return emptyReport({
      ok: false,
      applicable: true,
      diffError: message,
    });
  }

  if (changedFiles.length === 0) {
    return emptyReport({ changedFiles });
  }

  const materialDigest = args.materialDigest
    ?? computeDecisionDocMaterialDigest(args.projectRoot, changedFiles, args.headRef ?? 'HEAD');
  const events = readEvents(args);
  const ignoredVerdicts: IgnoredDecisionDocVerdict[] = [];
  const hostsByRun = new Map<string, Map<string, string>>();

  events.forEach((event, index) => {
    const type = normalizeString(event.type);
    const runId = normalizeString(event.runId);
    const hostId = normalizeHostId(event.hostId);
    const decision = normalizeString(event.decision).toLowerCase();
    const eventDigest = normalizeString(event.materialDigest);
    const verdictId = normalizeString(event.verdictId);
    const reasons: string[] = [];

    if (type !== 'host_verdict') reasons.push(`ignored type=${type || '<missing>'}`);
    if (!runId) reasons.push('missing runId');
    if (!hostId) reasons.push('missing hostId');
    if (decision !== 'pass') reasons.push(`decision is ${decision || '<missing>'}`);
    if (eventDigest !== materialDigest) reasons.push(`materialDigest mismatch (${eventDigest || '<missing>'})`);

    if (reasons.length > 0) {
      ignoredVerdicts.push({
        index,
        type: type || '<missing>',
        ...(verdictId ? { verdictId } : {}),
        ...(runId ? { runId } : {}),
        ...(hostId ? { hostId } : {}),
        ...(decision ? { decision } : {}),
        ...(eventDigest ? { materialDigest: eventDigest } : {}),
        reasons,
      });
      return;
    }

    let hostMap = hostsByRun.get(runId);
    if (!hostMap) {
      hostMap = new Map<string, string>();
      hostsByRun.set(runId, hostMap);
    }
    if (hostMap.has(hostId)) {
      ignoredVerdicts.push({
        index,
        type,
        ...(verdictId ? { verdictId } : {}),
        runId,
        hostId,
        decision,
        materialDigest: eventDigest,
        reasons: [`duplicate hostId in run ${runId}`],
      });
      return;
    }
    hostMap.set(hostId, verdictId || `${runId}:${hostId}:${index}`);
  });

  const validRounds: DecisionDocQuorumRound[] = [];
  const invalidRounds: DecisionDocQuorumRound[] = [];
  for (const [runId, hostMap] of [...hostsByRun.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const passingHostIds = uniqueSorted(hostMap.keys());
    const passingVerdictIds = uniqueSorted(hostMap.values());
    const missingHosts = Math.max(0, REQUIRED_PASSING_HOSTS_PER_ROUND - passingHostIds.length);
    const round = {
      runId,
      passingHostIds,
      passingVerdictIds,
      reasons: missingHosts > 0 ? [`missing ${missingHosts} passing host(s)`] : [],
    };
    if (missingHosts === 0) validRounds.push(round);
    else invalidRounds.push(round);
  }

  const missingRounds = Math.max(0, REQUIRED_ROUNDS - validRounds.length);
  const missingHostsByRound = invalidRounds.map(round => ({
    runId: round.runId,
    passingHosts: round.passingHostIds.length,
    missingHosts: Math.max(0, REQUIRED_PASSING_HOSTS_PER_ROUND - round.passingHostIds.length),
  }));

  return {
    ok: missingRounds === 0,
    applicable: true,
    materialDigest,
    changedFiles,
    validRounds,
    invalidRounds,
    missing: {
      requiredRounds: REQUIRED_ROUNDS,
      requiredPassingHostsPerRound: REQUIRED_PASSING_HOSTS_PER_ROUND,
      validRounds: validRounds.length,
      rounds: missingRounds,
      hostsByRound: missingHostsByRound,
    },
    ignoredVerdicts,
  };
}

export function formatDecisionDocQuorumFailure(report: DecisionDocQuorumReport): string {
  if (report.ok) return '';
  if (report.diffError) {
    return `Decision-doc quorum diagnostic: could not determine docs/requirements/decisions/*.md changes. [decision_doc_quorum_diff_error]\n  - ${report.diffError}`;
  }
  const lines = [
    `Decision-doc quorum diagnostic: changed decision docs do not by themselves require DONE quorum. [decision_doc_quorum_diagnostic]`,
    `  - changed decision docs: ${report.changedFiles.map(f => `${f.path} (${f.status})`).join(', ') || 'none'}`,
    `  - materialDigest: ${report.materialDigest ?? '<missing>'}`,
    `  - diagnostic valid rounds: ${report.validRounds.length}/${report.missing.requiredRounds}; missing rounds: ${report.missing.rounds}`,
  ];
  for (const round of report.invalidRounds) {
    lines.push(`  - invalid round ${round.runId}: ${round.passingHostIds.length}/${report.missing.requiredPassingHostsPerRound} passing distinct host(s) (${round.reasons.join('; ')})`);
  }
  for (const ignored of report.ignoredVerdicts.slice(0, 8)) {
    const id = ignored.verdictId ?? `event#${ignored.index}`;
    lines.push(`  - ignored ${id}: ${ignored.reasons.join('; ')}`);
  }
  if (report.ignoredVerdicts.length > 8) {
    lines.push(`  - ... ${report.ignoredVerdicts.length - 8} more ignored verdict event(s)`);
  }
  lines.push('→ Use review_escalation_status to see whether DONE actually requires escalation; this command is classification/diagnostic only.');
  return lines.join('\n');
}

export function formatDecisionDocQuorumReport(report: DecisionDocQuorumReport): string {
  if (!report.applicable) {
    return 'Decision-doc quorum: not applicable (no docs/requirements/decisions/*.md changes against main...HEAD)';
  }
  if (report.ok) {
    return [
      'Decision-doc quorum: pass',
      `  - materialDigest: ${report.materialDigest}`,
      `  - valid rounds: ${report.validRounds.map(r => `${r.runId}(${r.passingHostIds.length} hosts)`).join(', ')}`,
    ].join('\n');
  }
  return formatDecisionDocQuorumFailure(report);
}
