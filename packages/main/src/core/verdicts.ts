import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { canonicalDigest } from './authority-signing.js';

export type VerdictMode = 'local' | 'authority';
export type VerdictDecision = 'pass' | 'fail' | 'blocked';

export interface HostVerdict {
  schemaVersion: 'lattice.host_verdict.v1';
  verdictId: string;
  mode: VerdictMode;
  storyId?: string;
  jobId?: string;
  runId: string;
  hostId: string;
  provider: 'codex' | 'claude' | 'gemini' | string;
  sessionId: string;
  keyId?: string;
  decision: VerdictDecision;
  materialDigest: string;
  validationDigest?: string;
  gateInputDigest?: string;
  receiptId?: string;
  promptDigest?: string;
  issuedAt: string;
  note: string;
}

export interface VerdictSummary {
  schemaVersion: 'lattice.verdict_summary.v1';
  mode: VerdictMode;
  storyId?: string;
  jobId?: string;
  runId: string;
  totalVerdicts: number;
  independentHosts: number;
  passingIndependentHosts: number;
  failingIndependentHosts: number;
  duplicateVerdicts: number;
  localReviewCertified: boolean;
  authorityDone: boolean;
  fullAuthorityDone: boolean;
  multiHostVerified: boolean;
  status: 'pass' | 'blocked';
  blockedReason?: string;
  verdicts: HostVerdict[];
}

export interface VerdictSubmitArgs {
  mode: VerdictMode;
  verdictFile?: string;
  storyId?: string;
  jobId?: string;
  runId?: string;
  hostId?: string;
  provider?: string;
  sessionId?: string;
  keyId?: string;
  decision?: VerdictDecision;
  materialDigest?: string;
  validationDigest?: string;
  gateInputDigest?: string;
  receiptId?: string;
  promptDigest?: string;
  note?: string;
}

function baseDir(root: string, mode: VerdictMode, id: string): string {
  return join(root, '.koala', mode === 'authority' ? 'authority-verdicts' : 'autopilot-verdicts', id);
}

function readVerdictFile(root: string, file: string): Partial<HostVerdict> {
  const path = file.startsWith('/') ? file : join(root, file);
  return JSON.parse(readFileSync(path, 'utf8')) as Partial<HostVerdict>;
}

function identityOf(verdict: HostVerdict): string {
  // Independence is keyed by the stable host identity (hostId + provider + keyId),
  // NOT the per-session id. Including sessionId would let a single host re-submit
  // under a fresh session and be counted twice toward independent host coverage.
  // Components are trimmed/lower-cased so trivial whitespace/case variants cannot
  // masquerade as a distinct host.
  const norm = (value: string | undefined): string => (value ?? '').trim().toLowerCase();
  return [norm(verdict.hostId), norm(verdict.provider), norm(verdict.keyId)].join('|');
}

function idFor(args: VerdictSubmitArgs): string {
  if (args.mode === 'authority') {
    if (!args.jobId) throw new Error('jobId is required for authority verdicts');
    return args.jobId;
  }
  if (!args.storyId) throw new Error('storyId is required for local autopilot review verdicts');
  return args.storyId;
}

export function submitVerdict(root: string, args: VerdictSubmitArgs, now = new Date()): HostVerdict {
  const fromFile = args.verdictFile ? readVerdictFile(root, args.verdictFile) : {};
  const merged = { ...fromFile, ...args };
  const mode = merged.mode;
  const runId = merged.runId || 'default-run';
  const hostId = merged.hostId || merged.provider || 'unknown-host';
  const provider = merged.provider || 'unknown';
  const sessionId = merged.sessionId || 'unknown-session';
  const decision = merged.decision || 'blocked';
  const materialDigest = merged.materialDigest || merged.validationDigest || merged.gateInputDigest || 'missing-material-digest';
  const base = {
    schemaVersion: 'lattice.host_verdict.v1' as const,
    mode,
    storyId: merged.storyId,
    jobId: merged.jobId,
    runId,
    hostId,
    provider,
    sessionId,
    keyId: merged.keyId,
    decision,
    materialDigest,
    validationDigest: merged.validationDigest,
    gateInputDigest: merged.gateInputDigest,
    receiptId: merged.receiptId,
    promptDigest: merged.promptDigest,
    issuedAt: now.toISOString(),
    note: merged.note || 'host verdict submitted',
  };
  const verdict: HostVerdict = {
    ...base,
    verdictId: `verdict-${canonicalDigest(base).slice(0, 16)}`,
  };
  const dir = baseDir(root, mode, idFor(args));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${verdict.verdictId}.json`), JSON.stringify(verdict, null, 2) + '\n', 'utf8');
  return verdict;
}

export function listVerdicts(root: string, mode: VerdictMode, id: string): HostVerdict[] {
  const dir = baseDir(root, mode, id);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter(name => name.endsWith('.json'))
    .map(name => JSON.parse(readFileSync(join(dir, name), 'utf8')) as HostVerdict)
    .sort((a, b) => a.issuedAt.localeCompare(b.issuedAt));
}

export function summarizeVerdicts(root: string, mode: VerdictMode, id: string, runId = 'default-run', requiredHosts = 2): VerdictSummary {
  const all = listVerdicts(root, mode, id).filter(verdict => verdict.runId === runId);
  // requiredHosts is a hard floor: coerce to a positive integer so a 0 / negative /
  // NaN value can never silently drop the multi-host requirement below 1.
  const required = Math.max(1, Math.floor(Number(requiredHosts)) || 2);

  // Group verdicts by host identity so duplicate identities collapse to one host.
  const groups = new Map<string, HostVerdict[]>();
  for (const verdict of all) {
    const identity = identityOf(verdict);
    const bucket = groups.get(identity);
    if (bucket) bucket.push(verdict);
    else groups.set(identity, [verdict]);
  }
  const independentHosts = groups.size;
  const duplicateVerdicts = all.length - independentHosts;

  // A host counts as passing only if EVERY verdict it submitted passes (fail-closed):
  // a single failing independent verdict for an identity makes that host failing and
  // therefore blocks, even if the same host also submitted a pass.
  const passingHosts: HostVerdict[] = [];
  const failingHosts: HostVerdict[] = [];
  for (const bucket of groups.values()) {
    const representative = bucket[bucket.length - 1];
    if (bucket.every(verdict => verdict.decision === 'pass')) passingHosts.push(representative);
    else failingHosts.push(representative);
  }

  const enough = passingHosts.length >= required;
  const noFailures = failingHosts.length === 0;
  const status = enough && noFailures ? 'pass' : 'blocked';
  const localReviewCertified = mode === 'local' && status === 'pass';

  // `fullAuthorityDone` is the multi-host verdict gate only. `authorityDone` (the
  // production DONE flag) is NEVER derived from host verdicts here — a `receiptId`
  // carried in a verdict is not a verified native gate_decision receipt. Real
  // receipt verification happens in the authority executor / receipt verifier, so
  // this summary always reports `authorityDone: false` and lets that path own it.
  const fullAuthorityDone = mode === 'authority' && status === 'pass';
  return {
    schemaVersion: 'lattice.verdict_summary.v1',
    mode,
    storyId: mode === 'local' ? id : undefined,
    jobId: mode === 'authority' ? id : undefined,
    runId,
    totalVerdicts: all.length,
    independentHosts,
    passingIndependentHosts: passingHosts.length,
    failingIndependentHosts: failingHosts.length,
    duplicateVerdicts,
    localReviewCertified,
    authorityDone: false,
    fullAuthorityDone,
    multiHostVerified: status === 'pass',
    status,
    blockedReason: status === 'pass' ? undefined : `requires ${required} passing independent host verdicts with no failing verdicts`,
    verdicts: all,
  };
}
