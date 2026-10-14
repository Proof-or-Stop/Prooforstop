/**
 * Lab round-cut N1 (bench-staging/oldpos/run74-75-analysis.md §7 N1): removed operand guards at DEV exit.
 *
 * In at least 5 of the 11 old-PoS runs 65-75 a refactor deleted a base operand guard (the branch for
 * a null / omitted operand, `end != NULL` replaced by `!endOmitted`), and the regression was found
 * by a review lane one to three rounds later (run 75: REVIEW round 3, then a full round 4; each
 * extra round about 17 min). The base→HEAD diff shows it deterministically: a condition line that
 * tests an operand for a class (null / omitted, negative, out of range, empty) disappears from a
 * function the Story kept, and no row or request sentence says the change is intended.
 *
 * Language-generic heuristics (the function extraction of core/counterpart-coverage.ts: Go, Python
 * and brace languages), no model:
 *   - changed files: modified, non-test source files of the Story base→HEAD diff (added, deleted or
 *     renamed files hold no "kept" function);
 *   - a removed guard: a removed line (old side of `git diff -U0`) that is a condition line
 *     (if / elif / while / guard / unless / assert / ternary) testing an operand for a class,
 *     inside a base function whose name (and owner) still exists in the HEAD file, and the HEAD
 *     function has no condition line testing the same operand for the same class (an `err != nil`
 *     check is no operand guard; a re-indented or inverted guard is kept);
 *   - confidence: `clear` when the HEAD function still uses the operand and no added line anywhere
 *     in the diff guards the same operand for the same class; `weak` otherwise (the guard moved
 *     into a helper, or the operand left the function);
 *   - justified (not listed): a checklist row or request sentence that names the function (call
 *     form) or the operand (3+ characters) together with the class (a null literal, a negative
 *     number, "out of range" / "beyond", an empty literal or "empty");
 *   - base behaviour: up to two base test lines that call the function with the class literal.
 *
 * Switch `dev.removedGuardScan` (core/ab-variants.ts; default `advisory`): advisory = every review
 * lane prompt names the removed guards (handlers/story-dispatch.ts); on = a clear one also reopens
 * the item that declares the file before REVIEW (a framework step, once per guard set; the
 * implementer relaunch carries the guards), weak ones stay advisory; off = no scan. The framework
 * never edits code and never blocks REVIEW on its own judgement: once the relaunch ran, the set is
 * left to REVIEW.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ChecklistItem } from './types.js';
import { extractFunctions, isScannedSource, isTestSource, langOf, maskSource, type FnDef } from './counterpart-coverage.js';
import { PROOF_OR_STOP_DIR } from './proof-or-stop-paths.js';
import { resolveCanonicalRuntimeProjectRoot } from './runtime-artifact-registry.js';
import { abVariantEvidenceOf, removedGuardScanMode, type AbVariantEvidence } from './ab-variants.js';
import { loadConfig } from './config.js';
import { pinOracleStoryBase } from './pin-oracle.js';
import { readStoryRequest } from './story-request.js';
import type { StoryStore } from './store.js';
import { VERIFICATION_LANES } from './verification.js';

export type GuardClass = 'null' | 'negative' | 'out_of_range' | 'empty';
export const GUARD_CLASS_LABEL: Record<GuardClass, string> = { null: 'null / omitted', negative: 'negative', out_of_range: 'out of range', empty: 'empty' };

export interface RemovedGuard {
  file: string;
  /** Line of the removed guard in the Story base file. */
  line: number;
  fn: string;
  /** The base line, trimmed. */
  text: string;
  cls: GuardClass;
  operand: string;
  confidence: 'clear' | 'weak';
  reason: string;
  /** Base test lines (`path:line: text`) calling the function with the class literal. */
  baseTests: string[];
}

const MAX_FILES = 200;
const MAX_FILE_BYTES = 400_000;
const MAX_TEST_FILES = 80;
const NOT_OPERANDS = /^(?:err|error|errs|e|ex|exc|ok|this|self|cls|true|false|nil|null|None|NULL|undefined)$/;

function git(cwd: string, args: string[]): string | null {
  try { return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 32 * 1024 * 1024 }); } catch { return null; }
}

// ---------------------------------------------------------------------------
// Guard signatures of one (masked) line

const EXPR = String.raw`[A-Za-z_$][\w$]*(?:\s*(?:\.|->)\s*[A-Za-z_$][\w$]*)*`;
const NULLS = String.raw`(?:nil|null|None|NULL|nullptr|undefined)`;
const LENGTH = String.raw`(?:\blen\s*\([^()]*\)|${EXPR}\s*\.\s*(?:length|size\s*\(\s*\)|Len\s*\(\s*\)|len\s*\(\s*\)|count|Count)\b|\b(?:n|len\w*|length|size|count|max\w*|limit|cap)\b)`;
const SIGNATURES: ReadonlyArray<readonly [GuardClass, RegExp]> = [
  ['null', new RegExp(`(?<![\\w$.])(${EXPR})\\s*(?:===?|!==?)\\s*${NULLS}\\b`, 'g')],
  ['null', new RegExp(`\\b${NULLS}\\s*(?:===?|!==?)\\s*(${EXPR})`, 'g')],
  ['null', new RegExp(`(?<![\\w$.])(${EXPR})\\s+is(?:\\s+not)?\\s+None\\b`, 'g')],
  ['negative', new RegExp(`(?<![\\w$.])(${EXPR})\\s*(?:<\\s*0(?![\\d.xX])|<=\\s*-\\s*1\\b|>=\\s*0(?![\\d.xX]))`, 'g')],
  ['negative', new RegExp(`\\b0\\s*(?:>|<=)\\s*(${EXPR})`, 'g')],
  ['out_of_range', new RegExp(`(?<![\\w$.])(${EXPR})\\s*(?:>=|>|<=|<)(?!=)\\s*${LENGTH}`, 'g')],
  ['out_of_range', new RegExp(`${LENGTH}\\s*(?:<=|<|>=|>)(?!=)\\s*(${EXPR})(?![\\w$])`, 'g')],
  ['empty', new RegExp(`\\blen\\s*\\(\\s*(${EXPR})\\s*\\)\\s*(?:==|<=|<)\\s*[01]\\b`, 'g')],
  ['empty', new RegExp(`(?<![\\w$.])(${EXPR})\\s*\\.\\s*(?:length|size\\s*\\(\\s*\\)|Len\\s*\\(\\s*\\)|len\\s*\\(\\s*\\)|count)\\s*(?:===?|<=?)\\s*0\\b`, 'g')],
  ['empty', new RegExp(`(?<![\\w$.])(${EXPR})\\s*===?\\s*(?:""|''|\\[\\s*\\])`, 'g')],
  ['empty', new RegExp(`(?<![\\w$.])(${EXPR})\\s*\\.\\s*(?:isEmpty|is_empty|IsEmpty)\\s*\\(`, 'g')],
  ['empty', new RegExp(`\\bnot\\s+(${EXPR})\\s*:`, 'g')],
];
const CONDITION = /\b(?:if|elif|while|guard|unless|assert|require|ensure|when)\b|^[^=]*\?[^:]+:/;
const normOperand = (operand: string): string => operand.replace(/\s+/g, '').replace(/->/g, '.');
const tailOf = (operand: string): string => operand.split('.').at(-1)!.toLowerCase();
const rootOf = (operand: string): string => operand.split('.')[0]!;

export interface GuardSignature { cls: GuardClass; operand: string }

/** The operand guards a masked source line states (condition lines only). */
export function guardSignatures(maskedLine: string): GuardSignature[] {
  if (!CONDITION.test(maskedLine) || /^\s*for\b/.test(maskedLine)) return [];
  const out: GuardSignature[] = [];
  for (const [cls, pattern] of SIGNATURES) {
    for (const match of maskedLine.matchAll(pattern)) {
      const operand = normOperand(match[1] ?? '');
      if (!operand || NOT_OPERANDS.test(operand)) continue;
      if (/^\d/.test(operand) || (cls === 'out_of_range' && new RegExp(`^${LENGTH}$`).test(operand))) continue;
      if (!out.some(row => row.cls === cls && row.operand === operand)) out.push({ cls, operand });
    }
  }
  return out;
}

const sameGuard = (a: GuardSignature, b: GuardSignature): boolean => a.cls === b.cls && (a.operand === b.operand || tailOf(a.operand) === tailOf(b.operand));

// ---------------------------------------------------------------------------
// Diff, functions, justification, base tests

interface Hunks { removed: Set<number>; added: Set<number> }
function hunksOf(gitCwd: string, base: string, head: string, file: string): Hunks {
  const removed = new Set<number>();
  const added = new Set<number>();
  for (const match of (git(gitCwd, ['diff', '-U0', '--no-color', '--no-renames', base, head, '--', file]) ?? '').matchAll(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm)) {
    const oldStart = Number(match[1]); const oldCount = match[2] === undefined ? 1 : Number(match[2]);
    const newStart = Number(match[3]); const newCount = match[4] === undefined ? 1 : Number(match[4]);
    for (let line = oldStart; line < oldStart + oldCount; line += 1) removed.add(line);
    for (let line = newStart; line < newStart + newCount; line += 1) added.add(line);
  }
  return { removed, added };
}

const fnEndLine = (fn: FnDef): number => fn.bodyLine + fn.body.split('\n').length - 1;
const fnAt = (fns: readonly FnDef[], line: number): FnDef | undefined =>
  fns.filter(fn => fn.line <= line && line <= fnEndLine(fn)).sort((a, b) => (fnEndLine(a) - a.line) - (fnEndLine(b) - b.line))[0];
const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Every guard a function's body states (condition lines), from its masked text. */
function bodyGuards(fn: FnDef): GuardSignature[] {
  return fn.masked.split('\n').flatMap(line => guardSignatures(line));
}

const CLASS_LITERAL: Record<GuardClass, RegExp> = {
  null: /\b(?:nil|null|NULL|None|undefined|nullptr)\b/,
  negative: /(?:^|[^\w.)\]])-\s*\d/,
  out_of_range: /\bout[ -]of[ -](?:range|bounds)\b|\bbeyond\b|\bpast the end\b|\bexceeds?\b|\btoo (?:large|big|long)\b/i,
  empty: /""|''|\[\s*\]|\bempty\b/i,
};

function namesText(text: string, guard: Pick<RemovedGuard, 'fn' | 'operand'>): boolean {
  if (new RegExp(`(?<![\\w$])${escapeRegExp(guard.fn)}\\s*\\(`).test(text)) return true;
  const tail = guard.operand.split('.').at(-1)!;
  return tail.length >= 3 && new RegExp(`(?<![\\w$])${escapeRegExp(tail)}(?![\\w$])`, 'i').test(text);
}

/** A row or request sentence that names the function or operand together with the class: the change is the Story's to decide. */
export function guardJustified(guard: Pick<RemovedGuard, 'fn' | 'operand' | 'cls'>, texts: readonly string[]): string | null {
  for (const text of texts) {
    if (namesText(text, guard) && CLASS_LITERAL[guard.cls].test(text)) return text.length > 160 ? `${text.slice(0, 159)}…` : text;
  }
  return null;
}

function baseTestLines(gitCwd: string, base: string, tests: readonly string[], guard: Pick<RemovedGuard, 'fn' | 'cls'>, cache: Map<string, string | null>): string[] {
  const call = new RegExp(`(?<![\\w$])${escapeRegExp(guard.fn)}\\s*\\(`);
  const out: string[] = [];
  for (const path of tests) {
    if (!cache.has(path)) cache.set(path, git(gitCwd, ['show', `${base}:${path}`]));
    const text = cache.get(path);
    if (!text) continue;
    text.split('\n').forEach((line, index) => {
      if (out.length < 2 && call.test(line) && CLASS_LITERAL[guard.cls].test(line)) out.push(`${path}:${index + 1}: ${line.trim().slice(0, 140)}`);
    });
    if (out.length >= 2) break;
  }
  return out;
}

const sentencesOf = (text: string | null | undefined): string[] => (text ?? '').split(/\n|(?<=[.!?])\s+/).map(row => row.trim()).filter(Boolean);

// ---------------------------------------------------------------------------
// The scan

/** Operand guards the Story base→HEAD diff removed from functions it kept (see the module comment). */
export function scanRemovedGuards(args: { gitCwd: string; base: string; head?: string; rowTexts?: readonly string[]; requestText?: string | null }): RemovedGuard[] {
  const head = args.head ?? 'HEAD';
  const changed = (git(args.gitCwd, ['diff', '--name-only', '--no-renames', '--diff-filter=M', args.base, head]) ?? '')
    .split('\n').map(line => line.trim()).filter(path => path && isScannedSource(path) && !isTestSource(path)).slice(0, MAX_FILES);
  if (!changed.length) return [];
  const texts = [...(args.rowTexts ?? []), ...sentencesOf(args.requestText)];
  const files = changed.flatMap(file => {
    const baseText = git(args.gitCwd, ['show', `${args.base}:${file}`]);
    const headText = git(args.gitCwd, ['show', `${head}:${file}`]);
    if (baseText === null || headText === null || baseText.length > MAX_FILE_BYTES || headText.length > MAX_FILE_BYTES) return [];
    return [{ file, baseText, headText, hunks: hunksOf(args.gitCwd, args.base, head, file),
      baseFns: extractFunctions({ path: file, text: baseText }), headFns: extractFunctions({ path: file, text: headText }) }];
  });
  // Guards the diff ADDED anywhere (a guard that moved into a helper).
  const addedGuards: Array<GuardSignature & { file: string; line: number; fn: string | null }> = [];
  for (const row of files) {
    const masked = maskSource(row.headText, langOf(row.file)).split('\n');
    for (const line of row.hunks.added) {
      for (const signature of guardSignatures(masked[line - 1] ?? '')) addedGuards.push({ ...signature, file: row.file, line, fn: fnAt(row.headFns, line)?.name ?? null });
    }
  }
  let tests: string[] | null = null;
  const testCache = new Map<string, string | null>();
  const out: RemovedGuard[] = [];
  for (const row of files) {
    const baseMasked = maskSource(row.baseText, langOf(row.file)).split('\n');
    const baseLines = row.baseText.split('\n');
    for (const line of [...row.hunks.removed].sort((a, b) => a - b)) {
      const signatures = guardSignatures(baseMasked[line - 1] ?? '');
      if (!signatures.length) continue;
      const fn = fnAt(row.baseFns, line);
      if (!fn) continue;
      const kept = row.headFns.find(candidate => candidate.name === fn.name && candidate.owner === fn.owner);
      if (!kept) continue;
      const headGuards = bodyGuards(kept);
      for (const signature of signatures) {
        if (headGuards.some(guard => sameGuard(guard, signature))) continue;
        if (out.some(guard => guard.file === row.file && guard.fn === fn.name && guard.cls === signature.cls && guard.operand === signature.operand)) continue;
        const candidate = { fn: fn.name, operand: signature.operand, cls: signature.cls };
        if (guardJustified(candidate, texts)) continue;
        const bodyText = langOf(row.file) === 'py' ? kept.masked.split('\n').slice(1).join('\n') : kept.masked;
        const used = new RegExp(`(?<![\\w$])${escapeRegExp(rootOf(signature.operand))}(?![\\w$])`).test(bodyText);
        const moved = addedGuards.find(guard => sameGuard(guard, signature) && !(guard.file === row.file && guard.fn === fn.name));
        const confidence: RemovedGuard['confidence'] = used && !moved ? 'clear' : 'weak';
        const reason = moved
          ? `a guard of the same class on ${moved.operand} was added elsewhere: ${moved.file}:${moved.line}${moved.fn ? ` (${moved.fn})` : ''}`
          : !used ? `${fn.name} no longer uses ${signature.operand}` : `${fn.name} still uses ${signature.operand} and nothing in the diff guards it for this class`;
        tests ??= (git(args.gitCwd, ['ls-tree', '-r', '--name-only', args.base]) ?? '').split('\n').filter(path => path && isScannedSource(path) && isTestSource(path)).slice(0, MAX_TEST_FILES);
        out.push({ file: row.file, line, fn: fn.name, text: (baseLines[line - 1] ?? '').trim().slice(0, 160), cls: signature.cls, operand: signature.operand,
          confidence, reason, baseTests: baseTestLines(args.gitCwd, args.base, tests, candidate, testCache) });
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Story level: switch, rows, request, evidence, once-per-set reopen state

export const REMOVED_GUARD_SCHEMA = 'proof-or-stop.removed-guard-scan.v1' as const;

export function checklistRowTexts(items: readonly Pick<ChecklistItem, 'title' | 'userSees' | 'verificationIntent' | 'status'>[]): string[] {
  const out: string[] = [];
  for (const item of items) {
    if (item.status === 'withdrawn') continue;
    if (typeof item.userSees === 'string') out.push(item.userSees);
    for (const lane of VERIFICATION_LANES) for (const row of item.verificationIntent?.[lane] ?? []) if (typeof row.desc === 'string') out.push(row.desc);
  }
  return out;
}

export interface StoryRemovedGuards { mode: 'advisory' | 'on'; base: string; guards: RemovedGuard[]; abVariant?: AbVariantEvidence }
const memo = new Map<string, RemovedGuard[]>();

/** The Story's removed guards under its switch, or null (off, no base, unreadable config). */
export function storyRemovedGuards(store: Pick<StoryStore, 'readStory' | 'readChecklist' | 'storyFilePath'>, root: string, storyId: string, gitCwd: string): StoryRemovedGuards | null {
  let config: unknown;
  try { config = loadConfig(root); } catch { return null; }
  const mode = removedGuardScanMode(config);
  if (mode === 'off') return null;
  let base: string | null = null;
  try { base = pinOracleStoryBase(gitCwd, (store.readStory(storyId) as { integrationTarget?: { parentCommitAtCreation?: string } }).integrationTarget?.parentCommitAtCreation); } catch { base = null; }
  if (!base) return null;
  const head = git(gitCwd, ['rev-parse', 'HEAD'])?.trim();
  if (!head) return null;
  let rowTexts: string[] = [];
  try { rowTexts = checklistRowTexts(store.readChecklist(storyId).items); } catch { rowTexts = []; }
  const request = readStoryRequest(store as never, storyId);
  const requestText = request.status === 'ok' ? request.text : null;
  const key = createHash('sha256').update(JSON.stringify([gitCwd, base, head, rowTexts, requestText])).digest('hex');
  let guards = memo.get(key);
  if (!guards) {
    guards = scanRemovedGuards({ gitCwd, base, head, rowTexts, requestText });
    memo.set(key, guards);
  }
  const abVariant = abVariantEvidenceOf(config);
  return { mode, base, guards, ...(abVariant ? { abVariant } : {}) };
}

export interface RemovedGuardState { key: string; itemId: string; flaggedAt: string; guards: RemovedGuard[]; abVariant?: AbVariantEvidence }

export function removedGuardStatePath(root: string, storyId: string): string {
  return join(resolveCanonicalRuntimeProjectRoot(root), PROOF_OR_STOP_DIR, 'runtime', 'removed-guard-scan', `${storyId}.json`);
}
export function readRemovedGuardState(root: string, storyId: string): RemovedGuardState | null {
  try { return JSON.parse(readFileSync(removedGuardStatePath(root, storyId), 'utf8')) as RemovedGuardState; } catch { return null; }
}
function writeRemovedGuardState(root: string, storyId: string, state: RemovedGuardState): void {
  const path = removedGuardStatePath(root, storyId);
  try { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, `${JSON.stringify({ schema: REMOVED_GUARD_SCHEMA, ...state }, null, 1)}\n`); } catch { /* runtime evidence; recomputed */ }
}
export const removedGuardKeyOf = (guards: readonly RemovedGuard[]): string => guards.map(guard => `${guard.file}:${guard.fn}:${guard.cls}:${guard.operand}`).sort().join('|');

/** The item a guard reopens: the first live item that declares the guard's file, else the last live item. */
function reopenItemFor(items: readonly ChecklistItem[], guards: readonly RemovedGuard[]): ChecklistItem | undefined {
  const live = items.filter(item => item.status !== 'withdrawn');
  const files = new Set(guards.map(guard => guard.file));
  return live.find(item => [...(item.files?.modify ?? []), ...(item.files?.create ?? [])].some(file => files.has(file))) ?? live.at(-1);
}

/**
 * dev.removedGuardScan=on: when every live item is done, the clear removed guards reopen ONE item
 * once per guard set; after that item's implementer relaunch ran, the set is left to REVIEW (its
 * lanes get the advisory note). Null otherwise.
 */
export function openRemovedGuardGap(args: { root: string; gitCwd: string; store: Pick<StoryStore, 'readStory' | 'readChecklist' | 'storyFilePath'>; storyId: string; items: readonly ChecklistItem[];
  implementerRunsSince: (itemId: string, since: string) => boolean }): { itemId: string; guards: RemovedGuard[] } | null {
  const live = args.items.filter(item => item.status !== 'withdrawn');
  if (!live.length || live.some(item => item.status !== 'done')) return null;
  const scan = storyRemovedGuards(args.store, args.root, args.storyId, args.gitCwd);
  if (!scan || scan.mode !== 'on') return null;
  const clear = scan.guards.filter(guard => guard.confidence === 'clear');
  if (!clear.length) return null;
  const key = removedGuardKeyOf(clear);
  const state = readRemovedGuardState(args.root, args.storyId);
  if (state && state.key === key) {
    if (args.implementerRunsSince(state.itemId, state.flaggedAt)) return null;
    return { itemId: state.itemId, guards: clear };
  }
  const item = reopenItemFor(live, clear);
  if (!item) return null;
  writeRemovedGuardState(args.root, args.storyId, { key, itemId: item.id, flaggedAt: new Date().toISOString(), guards: clear, ...(scan.abVariant ? { abVariant: scan.abVariant } : {}) });
  return { itemId: item.id, guards: clear };
}

/** The reopened item's implementer relaunch is pending (no run of it since the flag): a framework launch once. */
export function removedGuardRelaunchPending(root: string, storyId: string, itemId: string, implementerRunsSince: (itemId: string, since: string) => boolean): boolean {
  const state = readRemovedGuardState(root, storyId);
  return Boolean(state && state.itemId === itemId && !implementerRunsSince(itemId, state.flaggedAt));
}

export function describeRemovedGuard(guard: RemovedGuard): string {
  return `${guard.file}:${guard.line} (base) in ${guard.fn}: \`${guard.text}\` — ${GUARD_CLASS_LABEL[guard.cls]} \`${guard.operand}\` (${guard.confidence}: ${guard.reason})`
    + (guard.baseTests.length ? `; base tests: ${guard.baseTests.join(' | ')}` : '');
}

/** The relaunch prompt lines of the item reopened for removed guards. */
export function renderRemovedGuardRelaunch(root: string, storyId: string, itemId: string): string[] {
  const state = readRemovedGuardState(root, storyId);
  if (!state || state.itemId !== itemId || !state.guards.length) return [];
  return [
    'Removed base guard(s) (framework scan of the Story base→HEAD diff, dev.removedGuardScan=on; reopened before REVIEW): the change removed or weakened these operand guards in functions it kept, and no checklist row or request sentence states that change:',
    ...state.guards.slice(0, 8).map(guard => `  - ${describeRemovedGuard(guard)}`),
    '- For each: keep the base behaviour for that operand class through the new code path and add a test pinning the base result (the base test line is the oracle; run the base in a detached temporary worktree when none is quoted), or, only when the request or a checklist row says the change is intended, report `[guard-intended] <file>:<line> <the request sentence or row>`. This set is not reopened again; REVIEW judges what remains.',
  ];
}

/** The advisory note of every review lane prompt (both modes): the removed guards present at the reviewed head. */
export function renderRemovedGuardAdvisory(scan: StoryRemovedGuards | null): string[] {
  if (!scan || !scan.guards.length) return [];
  return [
    `Removed base guards (framework scan of the Story base ${scan.base.slice(0, 12)}→HEAD, advisory, dev.removedGuardScan=${scan.mode}): operand guards the change dropped from functions it kept; no checklist row or request sentence states the change:`,
    ...scan.guards.slice(0, 8).map(guard => `- ${describeRemovedGuard(guard)}`),
    '- Probe each class on the current code against the base behaviour (the quoted base test is the oracle). A regression of base behaviour the request does not ask for is a finding (cite the base line); an intended change the request states is not.',
  ];
}
