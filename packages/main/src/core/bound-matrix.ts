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
 * `[branch-test] <fn> <operand>=<case>: <test> -> <result>` line per operand.
 *
 * Lab run89 (run88-89-analysis.md §3.3, fix 2): the check used to reject the whole repair (counted as
 * "ended without a repair commit", relaunched by the owner, then two DEV->PLAN trips: run 89 REM3,
 * 28.5 min for one report line). Now (a) a single-operand type switch is a dispatch table, not a
 * boundary list (`kind: 'dispatch'`: its arms are listed, no line is owed); (b) the prompt prints
 * the exact line per operand with the literal operand name; (c) a missing line is asked for by the
 * managed worker in the same session before the run seals (core/repair-report-lines.ts,
 * core/managed-host-run.ts) and never makes a commit-bearing repair "without a repair commit".
 * An error value's nil check (`err != nil`, `errObj == nil`) is not an operand branch.
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
import { branchTestProblem, branchTestTemplate } from './repair-report-lines.js';

export { branchTestProblem };

export interface BoundBranch { line: number; text: string; operand: string;
  /** Lab run89: a `switch x := x.(type)` line or one of its case arms (a dispatch table, not a boundary). */
  typeSwitch?: boolean }
export interface BoundMatrix { fn: string; file: string; line: number; operands: string[]; branches: BoundBranch[];
  /** `dispatch`: the helper only dispatches on one operand's type; no `[branch-test]` line is owed. Absent = operands. */
  kind?: 'operands' | 'dispatch';
  /** The case labels of a dispatch table. */
  arms?: string[] }

const MAX_BRANCHES = 12;
const CONDITION = /\b(?:if|elif|else\s+if|while|guard|unless|when|case|switch|match)\b|^[^=]*\?[^:]+:/;
const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function fileText(gitCwd: string, path: string): string | null {
  try { if (existsSync(join(gitCwd, path))) return readFileSync(join(gitCwd, path), 'utf8'); } catch { /* fall back to HEAD */ }
  try { return execFileSync('git', ['show', `HEAD:${path}`], { cwd: gitCwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 16 * 1024 * 1024 }); } catch { return null; }
}

const fnEndLine = (fn: FnDef): number => fn.bodyLine + fn.body.split('\n').length - 1;

/** An error value's nil check (`err != nil`, `errObj == nil`): a failure propagation, not an operand boundary. */
const ERROR_NIL = /(?<![\w$.])(?:err\w*|\w*Err(?:or|Obj)?|\w*[eE]rror)\s*[!=]==?\s*(?:nil|null|None|undefined)\b/;
/** A Go type switch (`switch v := x.(type)`, `switch x.(type)`). */
const TYPE_SWITCH = /\bswitch\b[^{]*\.\(\s*type\s*\)/;

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
  let typeSwitched = false;
  lines.forEach((line, index) => {
    if (!CONDITION.test(line) || /^\s*for\b/.test(line)) return;
    const caseArm = /^\s*(?:case\b|default\s*:)/.test(line);
    // Lab run89: an error value's nil check alone is no operand branch (run 89 F-005: `errObj != nil`).
    if (!caseArm && ERROR_NIL.test(line) && !line.replace(ERROR_NIL, '').match(compared)) return;
    const match = line.match(compared);
    const operand = match ? (match[1] ?? match[2] ?? match[3] ?? match[4] ?? null) : null;
    if (/\b(?:switch|match)\b/.test(line) && operand) { switched = operand; typeSwitched = TYPE_SWITCH.test(line); }
    const owner = caseArm ? switched : operand;
    if (!owner) return;
    const typeSwitch = (caseArm && typeSwitched) || (!caseArm && TYPE_SWITCH.test(line));
    out.push({ line: fn.bodyLine + index, text: (body[index] ?? '').trim().slice(0, 120), operand: owner, ...(typeSwitch ? { typeSwitch: true } : {}) });
  });
  return out;
}

/**
 * A matrix when the function branches on two operands or more, or on one operand in two forms or more (both signs of a
 * direction). Lab run89: type-switch lines and arms are not operand branches; a helper whose only branches are one
 * operand's type switch is a dispatch table (`kind: 'dispatch'`, its arms listed, no report line owed).
 */
export function matrixOfFunction(fn: FnDef): BoundMatrix | null {
  const all = functionBranches(fn);
  const name = fn.owner ? `${fn.owner}.${fn.name}` : fn.name;
  const branches = all.filter(row => !row.typeSwitch);
  const operands = [...new Set(branches.map(row => row.operand))];
  const forms = new Set(branches.map(row => row.text.replace(/\s+/g, '')));
  if (branches.length >= 2 && (operands.length >= 2 || forms.size >= 2)) {
    return { fn: name, file: fn.path, line: fn.line, operands: operands.sort(), branches: branches.slice(0, MAX_BRANCHES), kind: 'operands' };
  }
  const dispatch = all.filter(row => row.typeSwitch);
  const switchedOn = [...new Set(dispatch.map(row => row.operand))];
  if (dispatch.length >= 2 && switchedOn.length === 1) {
    const arms = dispatch.map(row => row.text.match(/^\s*case\s+(.+?)\s*:\s*$/)?.[1] ?? (/^\s*default\s*:/.test(row.text) ? 'default' : null)).filter((arm): arm is string => Boolean(arm));
    return { fn: name, file: fn.path, line: fn.line, operands: switchedOn, branches: dispatch.slice(0, MAX_BRANCHES), kind: 'dispatch', arms };
  }
  return null;
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
  if (matrix.kind === 'dispatch') {
    // Lab run89 (run 89 F-010): eleven type-switch arms were "branches of one operand"; a dispatch table is not a boundary list.
    return [
      `Type dispatch (framework): ${findingLabel} sits in ${matrix.fn} (${matrix.file}:${matrix.line}), which dispatches on the type of ${matrix.operands.join(', ')}${matrix.arms?.length ? ` (arms: ${matrix.arms.slice(0, 16).join(', ')})` : ''}. An arm is a node or value kind, not a boundary:`,
      `- Test the reported input's arm and every sibling arm that handles its input the same way (the same rendering, conversion or check), and list each on a \`[family]\` line (fixed / unaffected and why). No \`[branch-test]\` line is required for a dispatch table.`,
    ];
  }
  return [
    `Bound matrix (framework): ${findingLabel} sits in ${matrix.fn} (${matrix.file}:${matrix.line}), which branches on ${matrix.operands.join(', ')}. A repair that fixes only the reported branch leaves its siblings for the next review round:`,
    ...matrix.branches.map(branch => `  - ${matrix.file}:${branch.line} [${branch.operand}] ${branch.text}`),
    `- Test every branch of ${matrix.fn} in this repair: each operand (${matrix.operands.join(', ')}) on each class the request or the Story base defines for it (omitted / null, negative, below -len, zero, beyond len, and both signs of a direction operand; read and write paths where the helper serves both), compare each result with the request (the base where the request is silent), and fix every wrong one together.`,
    '- In your final report add exactly these lines, one per operand (fill in <case>, <test name> and <result>; the operand name stays as written):',
    ...matrix.operands.map(operand => `  ${branchTestTemplate(matrix.fn, operand)}`),
    '- A report that misses one of them is asked for the missing line before your run ends; the repair itself is not relaunched for it.',
  ];
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
