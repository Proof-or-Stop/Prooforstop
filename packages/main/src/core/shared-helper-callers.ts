/**
 * Lab run137 (bench-staging/oldpos/run137-analysis.md "Why the findings trickled in" 2-3, fix M second half and fix P;
 * new-PoS ADR-056 "check it holds on every path that uses the changed code: its direct callers" and ADR-071 class check).
 *
 * Run 137 F-004 ("a huge positive step wraps negative") was repaired in a normalisation helper the two-part read path also
 * calls; the repair was verified against its own finding only, so the next round found F-006 / F-007 ("two-part oversized
 * bounds now clamp"): one extra round, about 24 min. Nothing told the repairer, or a reviewer, which other callers the
 * changed helper has.
 *
 * A shared helper is a non-test function with at least two call sites in the Story's changed source files (the Story
 * diff, base..HEAD). This module finds them, from the code only (no task values):
 *   - sharedHelpersAtFinding: the function a finding sits in (its `file:line`, else a function of its files the
 *     description names) when it is shared: the repair prompt lists its call sites up front;
 *   - changedSharedHelpers: the functions a repair's own commits changed that are shared: the managed worker asks, in
 *     the repair's own session before the run seals, for one `[caller-check]` line per call site (base vs HEAD);
 *   - renderSharedHelperCallers: the prompt block (the report check, missingCallerChecks, is in core/repair-report-lines.ts,
 *     a leaf module the worker imports).
 * Call sites are found textually on the masked source (comments and strings blanked): a plain function by its name
 * followed by `(` (a package-qualified call included), a method by `.name(`. Bounded: HELPER_MAX helpers, SITE_MAX
 * sites each.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { extractFunctions, isScannedSource, isTestSource, langOf, maskSource, type FnDef } from './counterpart-coverage.js';
import { parseUnifiedZeroDiff } from './evidence-chain-check.js';
import { CALLER_CHECK_LINE_FORM, type CallSiteLike, type SharedHelperLike } from './repair-report-lines.js';

export type CallSite = CallSiteLike;
export type SharedHelper = SharedHelperLike;
export { CALLER_CHECK_LINE_FORM, missingCallerChecks } from './repair-report-lines.js';

const HELPER_MAX = 4;
const SITE_MAX = 8;
const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const fnEndLine = (fn: FnDef): number => fn.bodyLine + fn.body.split('\n').length - 1;

function tryGit(gitCwd: string, args: string[]): string | null {
  try { return execFileSync('git', args, { cwd: gitCwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 }); } catch { return null; }
}

/** A file's text at `ref` (null = the work tree, falling back to HEAD). */
function textAt(gitCwd: string, ref: string | null, path: string): string | null {
  if (ref) return tryGit(gitCwd, ['show', `${ref}:${path}`]);
  try { if (existsSync(join(gitCwd, path))) return readFileSync(join(gitCwd, path), 'utf8'); } catch { /* fall back to HEAD */ }
  return tryGit(gitCwd, ['show', `HEAD:${path}`]);
}

const sourcePaths = (out: string | null): string[] => (out ?? '').split('\n').map(line => line.trim()).filter(path => path && isScannedSource(path) && !isTestSource(path));

/** Non-test source files changed between `from` and `to` (to = null: the work tree). */
export function changedSources(gitCwd: string, from: string, to: string | null): string[] {
  return sourcePaths(tryGit(gitCwd, ['diff', '--name-only', '--no-renames', from, ...(to ? [to] : []), '--']));
}

/** The call sites of `fn` in `sources` (its own body and declaration excluded), each with its enclosing function. */
export function callSitesOf(fn: Pick<FnDef, 'name' | 'owner' | 'path' | 'line'> & { endLine: number }, sources: ReadonlyArray<{ path: string; text: string }>): CallSite[] {
  if (fn.name.length < 2) return [];
  const pattern = fn.owner
    ? new RegExp(`\\.${escapeRegExp(fn.name)}\\s*\\(`, 'g')
    : new RegExp(`(?<![\\w$.])(?:[A-Za-z_$][\\w$]*\\.)?${escapeRegExp(fn.name)}\\s*\\(`, 'g');
  const sites: CallSite[] = [];
  for (const source of sources) {
    const masked = maskSource(source.text, langOf(source.path));
    const lines = source.text.split('\n');
    const fns = extractFunctions(source);
    const maskedLines = masked.split('\n');
    maskedLines.forEach((line, index) => {
      const number = index + 1;
      if (source.path === fn.path && number >= fn.line && number <= fn.endLine) return;
      pattern.lastIndex = 0;
      if (!pattern.test(line)) return;
      // A declaration line (`func name(`, `def name(`, `function name(`) is no call.
      if (new RegExp(`(?:^|\\s)(?:func|def|function|fn)\\s+(?:\\([^)]*\\)\\s*)?${escapeRegExp(fn.name)}\\s*\\(`).test(line)) return;
      const caller = fns.filter(row => row.line <= number && number <= fnEndLine(row)).sort((a, b) => (fnEndLine(a) - a.line) - (fnEndLine(b) - b.line))[0];
      sites.push({ file: source.path, line: number, caller: caller ? caller.name : '<top level>', text: (lines[index] ?? '').trim().slice(0, 160) });
    });
  }
  return sites;
}

/** The shared helpers among `fns`: at least two call sites in `sources`. */
function sharedOf(fns: readonly FnDef[], sources: ReadonlyArray<{ path: string; text: string }>): SharedHelper[] {
  const out: SharedHelper[] = [];
  const seen = new Set<string>();
  for (const fn of fns) {
    const key = `${fn.path}:${fn.owner ?? ''}.${fn.name}`;
    if (seen.has(key) || fn.test) continue;
    seen.add(key);
    const sites = callSitesOf({ ...fn, endLine: fnEndLine(fn) }, sources);
    if (sites.length >= 2) out.push({ fn: fn.name, file: fn.path, line: fn.line, sites: sites.slice(0, SITE_MAX) });
    if (out.length >= HELPER_MAX) break;
  }
  return out;
}

const loadSources = (gitCwd: string, ref: string | null, paths: readonly string[]): Array<{ path: string; text: string }> =>
  [...new Set(paths)].flatMap(path => { const text = textAt(gitCwd, ref, path); return text === null ? [] : [{ path, text }]; });

/**
 * The function a finding sits in (its `file:line` locations, innermost function first; else a function of its files the
 * description names) when it is a shared helper of the Story diff (base..work tree). Empty without a base.
 */
export function sharedHelpersAtFinding(args: { gitCwd: string; baseRef: string | null | undefined; finding: { desc?: string; files?: readonly string[] } }): SharedHelper[] {
  if (!args.baseRef) return [];
  const desc = String(args.finding.desc ?? '');
  const cache = new Map<string, FnDef[]>();
  const fnsOf = (path: string): FnDef[] => {
    if (!cache.has(path)) {
      const text = isScannedSource(path) && !isTestSource(path) ? textAt(args.gitCwd, null, path) : null;
      cache.set(path, text === null ? [] : extractFunctions({ path, text }));
    }
    return cache.get(path)!;
  };
  const located: FnDef[] = [];
  for (const match of desc.matchAll(/([\w./-]+\.[A-Za-z]\w*):(\d+)/g)) {
    const path = match[1]!.replace(/^\.\//, '');
    const line = Number(match[2]);
    const fn = fnsOf(path).filter(row => row.line <= line && line <= fnEndLine(row)).sort((a, b) => (fnEndLine(a) - a.line) - (fnEndLine(b) - b.line))[0];
    if (fn) located.push(fn);
  }
  for (const path of (args.finding.files ?? []).map(row => row.replace(/:\d.*$/, ''))) {
    located.push(...fnsOf(path).filter(fn => fn.name.length >= 3 && new RegExp(`(?<![\\w$])${escapeRegExp(fn.name)}(?![\\w$])`).test(desc)));
  }
  if (!located.length) return [];
  const story = changedSources(args.gitCwd, args.baseRef, null);
  return sharedOf(located, loadSources(args.gitCwd, null, [...story, ...located.map(fn => fn.path)]));
}

/**
 * The functions the commits `from..to` changed (a changed line inside the function) that are shared helpers of the
 * Story diff at `to` (base..to): the call sites a repair's own change may have altered.
 */
export function changedSharedHelpers(args: { gitCwd: string; from: string; to?: string; baseRef: string | null | undefined }): SharedHelper[] {
  const to = args.to ?? 'HEAD';
  if (!args.baseRef || !args.from) return [];
  const touched = changedSources(args.gitCwd, args.from, to);
  if (!touched.length) return [];
  const diff = parseUnifiedZeroDiff(tryGit(args.gitCwd, ['diff', '-U0', '--no-renames', args.from, to, '--', ...touched]) ?? '');
  const changed: FnDef[] = [];
  for (const path of touched) {
    const lines = diff.get(path);
    const text = textAt(args.gitCwd, to, path);
    if (!lines?.size || text === null) continue;
    for (const fn of extractFunctions({ path, text })) {
      if ([...lines].some(line => line >= fn.line && line <= fnEndLine(fn))) changed.push(fn);
    }
  }
  if (!changed.length) return [];
  const story = changedSources(args.gitCwd, args.baseRef, to);
  return sharedOf(changed, loadSources(args.gitCwd, to, [...story, ...touched]));
}

/**
 * The prompt block naming each shared helper and its call sites. `repair`: the report owes one `[caller-check]` line per
 * caller (base vs HEAD); `review`: the lane enumerates what the change alters for every caller (review.classEnumeration).
 */
export function renderSharedHelperCallers(helpers: readonly SharedHelper[], mode: 'repair' | 'review'): string[] {
  if (!helpers.length) return [];
  const rows = helpers.flatMap(helper => [
    `- ${helper.fn} (${helper.file}:${helper.line}) is called from ${helper.sites.length} site${helper.sites.length > 1 ? 's' : ''} of the Story diff:`,
    ...helper.sites.map(site => `  - ${site.file}:${site.line} in ${site.caller}: \`${site.text}\``),
  ]);
  if (mode === 'repair') {
    return [
      'Shared helpers (framework, from the Story diff): a change to one of these changes every caller below, not only the path this finding names.',
      ...rows,
      `- If your repair changes such a helper, run each caller once on the Story base and once on your commit (one input that reaches the changed code) and end your report with one line per caller: \`${CALLER_CHECK_LINE_FORM}\`. A caller whose result changed without a request sentence or checklist row requiring it is a regression: fix it in this repair. The framework asks for any missing line before the run ends.`,
    ];
  }
  return [
    '--- BEGIN SHARED HELPER CALLERS ---',
    'In addition to your lane\'s own checks (not instead of them): the Story changed these helpers, and each has several callers in the Story diff.',
    ...rows,
    '- For each helper, list every behaviour the Story\'s change alters (each input class that now takes a different branch or returns a different value) and check each one for EVERY caller above against the Story base: run one input per altered behaviour per caller on the base and on HEAD. A caller whose result changed without a request sentence or checklist row requiring it is a finding (cite the caller, the input, the base and the HEAD result).',
    '--- END SHARED HELPER CALLERS ---',
  ];
}
