/**
 * Lab run89 (bench-staging/oldpos/run88-89-analysis.md §3.3, §5 fixes 2 and 3): the report lines a finding repair
 * owes, checked where the repair still runs.
 *
 * Run 89 REM3: the repair of F-010 committed a correct fix at 75:05, but its final report had no
 * `[branch-test] <fn> <operand>=...` line in the form the bound-matrix check wanted (the prompt showed
 * `<operand>=<case>` and never the literal operand). The framework counted the run as "ended without a repair
 * commit", the owner relaunched the whole repair by hand four times (reading the framework source to learn the check),
 * and two `finding_repair_replan` trips sent an unchanged plan back to PLAN: 28.5 min and 16.1M input tokens for a
 * report line.
 *
 * Now a missing report line is a report problem, not a repair problem: the managed worker (core/managed-host-run.ts)
 * resumes the SAME provider session before the run seals and asks for the missing lines only, quoting the exact
 * template (`repairReportFollowUp`); the commit stays, nothing is relaunched, nothing goes to PLAN. A report that still
 * misses a line after the follow-up is journaled and the repair is judged by its commit like any other (the next
 * review round reads the code as always). The same follow-up carries the `[mechanism]` line a regression chain's
 * repair owes (fix 3, core/regression-family-brief.ts).
 *
 * Leaf module (fs / path only besides the two path helpers): the worker imports it, so it must not pull the
 * next-driver or the matrix scanner into the worker's import graph (import-cycles ratchet).
 */
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { PROOF_OR_STOP_DIR } from './proof-or-stop-paths.js';
import { resolveCanonicalRuntimeProjectRoot } from './runtime-artifact-registry.js';

/** The part of a bound matrix the report check reads (core/bound-matrix.ts records the whole matrix). */
export interface MatrixLike {
  fn: string;
  operands: string[];
  /** `dispatch`: a single-operand type switch (a dispatch table, not a boundary list): no report line is owed. */
  kind?: 'operands' | 'dispatch';
}

/** What a regression chain's repair owes: the `[mechanism]` line (core/regression-family-brief.ts). */
export interface MechanismRequirement {
  findingId: string;
  /** Short ids, oldest first, ending at this finding (at least three: two `[regression-of]` links). */
  chain: string[];
  requestText: string | null;
}

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const shortId = (id: string): string => id.split(':').pop() ?? id;

/** The exact `[branch-test]` line of one operand, as the repair prompt prints it. */
export function branchTestTemplate(fn: string, operand: string): string {
  return `[branch-test] ${fn} ${operand}=<case>: <test name> -> <result>`;
}

/** The exact `[mechanism]` line forms, as the repair prompt prints them. */
export const MECHANISM_LINE_FORMS = [
  '[mechanism] <mechanism>: required by request "<verbatim request sentence>"',
  '[mechanism] <mechanism>: required by row <CHK-NNN:lane:i>',
  '[mechanism] <mechanism>: none -> removed',
] as const;

/** Operands of the matrix without a `[branch-test]` line naming them (standalone word, any case). */
export function missingBranchOperands(report: string | null | undefined, matrix: MatrixLike): string[] {
  if (matrix.kind === 'dispatch') return [];
  const lines = (report ?? '').split('\n').filter(line => /\[branch-test\]/i.test(line));
  return matrix.operands.filter(operand => !lines.some(line => new RegExp(`(?<![\\w$])${escapeRegExp(operand)}(?![\\w$])`, 'i').test(line)));
}

/** Null when the report carries a `[branch-test]` line naming every operand of the matrix (a dispatch table owes none); else what is missing, with the exact lines. */
export function branchTestProblem(report: string | null | undefined, matrix: MatrixLike): string | null {
  if (matrix.kind === 'dispatch') return null;
  const lines = matrix.operands.map(operand => branchTestTemplate(matrix.fn, operand));
  if (!report) return `no final report was retained, so the [branch-test] lines of ${matrix.fn} cannot be checked (bound matrix); the lines are: ${lines.map(line => `\`${line}\``).join(', ')}`;
  const missing = missingBranchOperands(report, matrix);
  return missing.length
    ? `its final report has no [branch-test] line for ${missing.join(', ')} of ${matrix.fn} (bound matrix); the missing line${missing.length > 1 ? 's are' : ' is'}: ${missing.map(operand => `\`${branchTestTemplate(matrix.fn, operand)}\``).join(', ')}`
    : null;
}

const squash = (text: string): string => text.replace(/[`"“”]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();

/**
 * Null when the report has a `[mechanism]` line that names what requires the mechanism: a request sentence quoted
 * verbatim (checked against the request text), a checklist row, or `none` (the mechanism was removed); else the problem.
 */
export function mechanismLineProblem(report: string | null | undefined, requirement: MechanismRequirement): string | null {
  const chain = requirement.chain.join(' -> ');
  const line = (report ?? '').split('\n').find(row => /\[mechanism\]/i.test(row));
  if (!line) return `its final report has no [mechanism] line (regression chain ${chain})`;
  const body = line.slice(line.toLowerCase().indexOf('[mechanism]') + '[mechanism]'.length);
  if (/:\s*none\b/i.test(body)) return null;
  if (/\brow\s+CHK-\d+(?::[A-Za-z]+:\d+)?/i.test(body)) return null;
  const quote = body.match(/\brequest\s*[:=]?\s*["“]([^"”]+)["”]/i)?.[1];
  if (quote) {
    if (!requirement.requestText) return null;
    const said = squash(quote);
    if (said.length >= 12 && squash(requirement.requestText).includes(said)) return null;
    return `the [mechanism] line quotes "${quote.slice(0, 160)}", which is not a sentence of the request (regression chain ${chain}): quote the request sentence verbatim, cite the row that pins the mechanism, or remove the mechanism and write none`;
  }
  return `the [mechanism] line names neither a request sentence (in quotes), a row (CHK-NNN:lane:i) nor none (regression chain ${chain})`;
}

/**
 * The follow-up prompt for a finding repair whose final report misses required lines: ONE resumed turn of the same
 * session that asks for exactly those lines (the commit stays; nothing else is redone). Null when nothing is missing.
 */
export function repairReportFollowUp(args: { report: string | null | undefined; matrices: ReadonlyArray<{ findingId: string; matrix: MatrixLike }>;
  mechanisms: readonly MechanismRequirement[] }): string | null {
  const parts: string[] = [];
  for (const { findingId, matrix } of args.matrices) {
    const missing = missingBranchOperands(args.report, matrix);
    if (!missing.length) continue;
    parts.push(`- ${shortId(findingId)} bound matrix of ${matrix.fn}: no [branch-test] line for ${missing.join(', ')}. If no test covers that branch yet, add one and commit it (one new commit), then add exactly:`,
      ...missing.map(operand => `  ${branchTestTemplate(matrix.fn, operand)}`));
  }
  for (const mechanism of args.mechanisms) {
    const problem = mechanismLineProblem(args.report, mechanism);
    if (!problem) continue;
    parts.push(`- ${shortId(mechanism.findingId)}: ${problem}. Add exactly one line, in one of these forms:`, ...MECHANISM_LINE_FORMS.map(form => `  ${form}`),
      '  If nothing requires the mechanism, remove it (restore the Story base behaviour for those inputs, one new commit) and write the `none -> removed` form.');
  }
  if (!parts.length) return null;
  return [
    'Report check (framework): your repair commit stays; only your final report is incomplete. Do not redo the repair and do not change product code beyond what a line below asks for.',
    ...parts,
    'Then reply with your complete final report again (every line it had, including the [intent-conflict] section) with these lines added.',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Runtime records (written when the repair prompt is built; read by the worker before the run seals)

const boundMatrixPath = (root: string, storyId: string): string => join(resolveCanonicalRuntimeProjectRoot(root), PROOF_OR_STOP_DIR, 'runtime', 'bound-matrix', `${storyId}.json`);
const mechanismPath = (root: string, storyId: string): string => join(resolveCanonicalRuntimeProjectRoot(root), PROOF_OR_STOP_DIR, 'runtime', 'repair-mechanism', `${storyId}.json`);

function readFindingsMap<T>(path: string): Record<string, T> {
  try { return (JSON.parse(readFileSync(path, 'utf8')) as { findings?: Record<string, T> }).findings ?? {}; } catch { return {}; }
}

/** The recorded bound matrices (core/bound-matrix.ts recordBoundMatrix) of a Story, by finding id. */
export function readRecordedMatrices(root: string, storyId: string): Record<string, MatrixLike & { at?: string }> {
  return readFindingsMap(boundMatrixPath(root, storyId));
}

/** Record a regression chain's `[mechanism]` requirement once per finding (the first prompt's chain stays the contract). */
export function recordMechanismRequirement(root: string, storyId: string, requirement: MechanismRequirement): void {
  const path = mechanismPath(root, storyId);
  const all = readFindingsMap<MechanismRequirement & { at: string }>(path);
  if (all[requirement.findingId]) return;
  all[requirement.findingId] = { ...requirement, requestText: requirement.requestText ? requirement.requestText.slice(0, 20_000) : null, at: new Date().toISOString() };
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify({ schema: 'proof-or-stop.repair-mechanism.v1', storyId, findings: all }, null, 1)}\n`);
  } catch { /* the prompt still asks for the line; the worker then has no record to check */ }
}

/** The report lines the repair of these findings owes (bound matrices and mechanism lines recorded at prompt build). */
export function readRepairReportRequirements(root: string, storyId: string, findingIds: readonly string[]): {
  matrices: Array<{ findingId: string; matrix: MatrixLike }>; mechanisms: MechanismRequirement[] } {
  const matrices = readRecordedMatrices(root, storyId);
  const mechanisms = readFindingsMap<MechanismRequirement>(mechanismPath(root, storyId));
  return {
    matrices: findingIds.flatMap(id => matrices[id] ? [{ findingId: id, matrix: matrices[id]! }] : []),
    mechanisms: findingIds.flatMap(id => mechanisms[id] ? [mechanisms[id]!] : []),
  };
}

/**
 * The last assistant message of a managed run's retained provider output (live-output.jsonl frames): codex
 * `item.completed` agent_message, claude `result`. Pure, so the worker reads it without importing the run reader.
 */
export function finalMessageFromLiveOutput(raw: string): string | null {
  let stdout = '';
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const frame = JSON.parse(line) as { stream?: string; text?: string };
      if (frame.stream === 'stdout' && typeof frame.text === 'string') stdout += frame.text;
    } catch { /* a partial frame at the tail boundary */ }
  }
  let last: string | null = null;
  for (const line of stdout.split('\n')) {
    if (!line.startsWith('{')) continue;
    try {
      const event = JSON.parse(line) as { type?: string; item?: { type?: string; text?: unknown }; result?: unknown };
      if (event.type === 'item.completed' && event.item?.type === 'agent_message' && typeof event.item.text === 'string') last = event.item.text;
      else if (event.type === 'result' && typeof event.result === 'string') last = event.result;
    } catch { /* not a provider event */ }
  }
  return last;
}
