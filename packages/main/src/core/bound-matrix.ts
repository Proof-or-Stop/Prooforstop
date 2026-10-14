/**
 * Lab round-cut N2 (bench-staging/oldpos/run74-75-analysis.md §7 N2): the bound matrix of a repair.
 *
 * Run 75 found three defects of one stepped-bounds helper one per review round: R1's repair fixed
 * the `start` normalisation the finding named, R2 found the `end` branch of the same helper twenty
 * lines below (and its repair fixed only `end`). Every repair forces a full next round (lanes +
 * critic, 8-10 min). When a finding sits in a helper that branches on several operands (start /
 * end / step, a switch over target kinds) or on both signs of one operand, the repair prompt now
 * carries a "bound matrix": the helper, every branch line and the requirement to test every
 * branch (each operand on each class the request or base defines) in this repair, reported as one
 * `[branch-test] <fn> <operand>=<case>: <test> -> <result>` line per operand. The framework checks
 * the lines exist: a repair whose report misses an operand is not accepted (it counts like a run
 * without a repair commit: relaunched once with what is missing, then the Story replans).
 *
 * Generic: the function extraction and operand derivation of core/counterpart-coverage.ts (Go,
 * Python, brace languages), no task values. Detection-neutral for REVIEW (no lane, critic, round
 * or verification changes); it moves sibling-branch tests into the first repair.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { derivedNames, extractFunctions, isScannedSource, isTestSource, type FnDef } from './counterpart-coverage.js';
import { PROOF_OR_STOP_DIR } from './proof-or-stop-paths.js';
import { resolveCanonicalRuntimeProjectRoot } from './runtime-artifact-registry.js';

export interface BoundBranch { line: number; text: string; operand: string }
export interface BoundMatrix { fn: string; file: string; line: number; operands: string[]; branches: BoundBranch[] }

const MAX_BRANCHES = 12;
const CONDITION = /\b(?:if|elif|else\s+if|while|guard|unless|when|case|switch|match)\b|^[^=]*\?[^:]+:/;
const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function fileText(gitCwd: string, path: string): string | null {
  try { if (existsSync(join(gitCwd, path))) return readFileSync(join(gitCwd, path), 'utf8'); } catch { /* fall back to HEAD */ }
  try { return execFileSync('git', ['show', `HEAD:${path}`], { cwd: gitCwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 16 * 1024 * 1024 }); } catch { return null; }
}

const fnEndLine = (fn: FnDef): number => fn.bodyLine + fn.body.split('\n').length - 1;

/** The branch lines of a function: condition lines comparing an operand (its leftmost operand is the branch's), and switch / case arms. */
export function functionBranches(fn: FnDef): BoundBranch[] {
  const { operands } = derivedNames(fn);
  if (!operands.size) return [];
  const names = [...operands].sort((a, b) => b.length - a.length).map(escapeRegExp).join('|');
  const compared = new RegExp(`(?<![\\w$.])(${names})(?![\\w$])\\s*(?:[<>]=?|[!=]==?|\\bis\\b|\\bin\\b)|(?:[<>]=?|[!=]==?)\\s*-?\\s*(${names})(?![\\w$])|\\bswitch\\b\\s*\\(?\\s*(${names})(?![\\w$])|\\bmatch\\s+(${names})(?![\\w$])`);
  const lines = fn.masked.split('\n');
  const body = fn.body.split('\n');
  const out: BoundBranch[] = [];
  let switched: string | null = null;
  lines.forEach((line, index) => {
    if (!CONDITION.test(line) || /^\s*for\b/.test(line)) return;
    const caseArm = /^\s*(?:case\b|default\s*:)/.test(line);
    const match = line.match(compared);
    const operand = match ? (match[1] ?? match[2] ?? match[3] ?? match[4] ?? null) : null;
    if (/\b(?:switch|match)\b/.test(line) && operand) switched = operand;
    const owner = caseArm ? switched : operand;
    if (!owner) return;
    out.push({ line: fn.bodyLine + index, text: (body[index] ?? '').trim().slice(0, 120), operand: owner });
  });
  return out;
}

/** A matrix when the function branches on two operands or more, or on one operand in two forms or more (both signs of a direction). */
export function matrixOfFunction(fn: FnDef): BoundMatrix | null {
  const branches = functionBranches(fn);
  if (branches.length < 2) return null;
  const operands = [...new Set(branches.map(row => row.operand))];
  const forms = new Set(branches.map(row => row.text.replace(/\s+/g, '')));
  if (operands.length < 2 && forms.size < 2) return null;
  return { fn: fn.owner ? `${fn.owner}.${fn.name}` : fn.name, file: fn.path, line: fn.line, operands: operands.sort(), branches: branches.slice(0, MAX_BRANCHES) };
}

/**
 * The helper a finding sits in: its `file:line` locations first (the innermost function holding the
 * line), else a function of its files the description names. Null when it cannot be located or the
 * helper has fewer than two branches / one operand in one form.
 */
export function boundMatrixFor(args: { gitCwd: string; finding: { desc?: string; files?: readonly string[] } }): BoundMatrix | null {
  const desc = String(args.finding.desc ?? '');
  const cache = new Map<string, FnDef[]>();
  const fnsOf = (path: string): FnDef[] => {
    if (!cache.has(path)) {
      const text = isScannedSource(path) && !isTestSource(path) ? fileText(args.gitCwd, path) : null;
      cache.set(path, text === null ? [] : extractFunctions({ path, text }));
    }
    return cache.get(path)!;
  };
  for (const match of desc.matchAll(/([\w./-]+\.[A-Za-z]\w*):(\d+)/g)) {
    const path = match[1]!.replace(/^\.\//, '');
    const line = Number(match[2]);
    const fn = fnsOf(path).filter(row => row.line <= line && line <= fnEndLine(row)).sort((a, b) => (fnEndLine(a) - a.line) - (fnEndLine(b) - b.line))[0];
    if (fn) return matrixOfFunction(fn);
  }
  const named = (args.finding.files ?? []).flatMap(path => fnsOf(path))
    .filter(fn => fn.name.length >= 3 && new RegExp(`(?<![\\w$])${escapeRegExp(fn.name)}(?![\\w$])`).test(desc))
    .sort((a, b) => b.name.length - a.name.length);
  for (const fn of named) {
    const matrix = matrixOfFunction(fn);
    if (matrix) return matrix;
  }
  return null;
}

/** The repair prompt block of a matrix. */
export function renderBoundMatrix(matrix: BoundMatrix, findingLabel = 'the finding'): string[] {
  return [
    `Bound matrix (framework): ${findingLabel} sits in ${matrix.fn} (${matrix.file}:${matrix.line}), which branches on ${matrix.operands.join(', ')}. A repair that fixes only the reported branch leaves its siblings for the next review round:`,
    ...matrix.branches.map(branch => `  - ${matrix.file}:${branch.line} [${branch.operand}] ${branch.text}`),
    `- Test every branch of ${matrix.fn} in this repair: each operand (${matrix.operands.join(', ')}) on each class the request or the Story base defines for it (omitted / null, negative, below -len, zero, beyond len, and both signs of a direction operand; read and write paths where the helper serves both), compare each result with the request (the base where the request is silent), and fix every wrong one together.`,
    `- In your final report add one line per operand: \`[branch-test] ${matrix.fn} <operand>=<case>: <test name> -> <result>\`. A repair whose report has no \`[branch-test]\` line for an operand of this matrix is not accepted (it is relaunched with what is missing).`,
  ];
}

/** Null when the report carries a `[branch-test]` line naming every operand of the matrix; else what is missing. */
export function branchTestProblem(report: string | null | undefined, matrix: Pick<BoundMatrix, 'fn' | 'operands'>): string | null {
  if (!report) return `no final report was retained, so the [branch-test] lines of ${matrix.fn} (${matrix.operands.join(', ')}) cannot be checked (bound matrix)`;
  const lines = report.split('\n').filter(line => /\[branch-test\]/i.test(line));
  const missing = matrix.operands.filter(operand => !lines.some(line => new RegExp(`(?<![\\w$])${escapeRegExp(operand)}(?![\\w$])`, 'i').test(line)));
  return missing.length ? `its final report has no [branch-test] line for ${missing.join(', ')} of ${matrix.fn} (bound matrix: every branch of the helper must be tested in the repair)` : null;
}

// ---------------------------------------------------------------------------
// Runtime record: the matrix a finding's repair prompt carried (the check reads it)

export interface RecordedBoundMatrix extends BoundMatrix { at: string }
const statePath = (root: string, storyId: string): string => join(resolveCanonicalRuntimeProjectRoot(root), PROOF_OR_STOP_DIR, 'runtime', 'bound-matrix', `${storyId}.json`);

function readAll(root: string, storyId: string): Record<string, RecordedBoundMatrix> {
  try { return (JSON.parse(readFileSync(statePath(root, storyId), 'utf8')) as { findings?: Record<string, RecordedBoundMatrix> }).findings ?? {}; } catch { return {}; }
}

/** Record the matrix of a finding's repair prompt once (the first prompt's matrix stays the contract). */
export function recordBoundMatrix(root: string, storyId: string, findingId: string, matrix: BoundMatrix): RecordedBoundMatrix {
  const all = readAll(root, storyId);
  const existing = all[findingId];
  if (existing) return existing;
  const row: RecordedBoundMatrix = { ...matrix, at: new Date().toISOString() };
  all[findingId] = row;
  try {
    const path = statePath(root, storyId);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify({ schema: 'proof-or-stop.bound-matrix.v1', storyId, findings: all }, null, 1)}\n`);
  } catch { /* the prompt still carries the matrix; the check then has no record */ }
  return row;
}

export function readBoundMatrix(root: string, storyId: string, findingId: string): RecordedBoundMatrix | null {
  return readAll(root, storyId)[findingId] ?? null;
}

/** The problem of one managed repair run of a finding against its recorded matrix (runs started before the record are not judged). */
export function repairRunBoundMatrixProblem(root: string, storyId: string, findingId: string, run: { createdAt: string }, report: () => string | null): string | null {
  const matrix = readBoundMatrix(root, storyId, findingId);
  if (!matrix) return null;
  if (Date.parse(run.createdAt) < Date.parse(matrix.at) - 120_000) return null;
  return branchTestProblem(report(), matrix);
}
