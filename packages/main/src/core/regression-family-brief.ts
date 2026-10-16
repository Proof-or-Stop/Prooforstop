/**
 * Old-PoS run 73 (bench-staging/oldpos/run73-analysis.md §6 B): the family-complete repair brief of a
 * regression finding.
 *
 * Run 73's "selector evaluated twice" defect was repaired four times: the first repair fixed the
 * direct case with a test of the direct case only, and three later findings (tagged
 * `[regression-of F-007]`) re-found the same mechanism through other target shapes. A finding that
 * says it re-found a resolved finding says the earlier repair did not cover its case, so the repair
 * prompt carries what that repair changed (its diff) and the earlier finding's repro, and requires
 * ONE test over every call site and every target shape of the mechanism, listed in the final report
 * on a `[family-test]` line. Prompt only: nothing is skipped and every finding is still resolved
 * through its own verified repair. Generic wording, no task values.
 *
 * Lab run89 (run88-89-analysis.md §3.4, §5 fix 3): run 89's printer family ran F-004 -> F-007 -> F-010 -> F-011, one
 * more variant per round, each repair's `[family]` lines wrong for the next one, because the mechanism under repair
 * existed only to satisfy an invented pin no request sentence states. From the second `[regression-of]` link of a chain
 * on (the third report of one mechanism) the brief adds a mechanism-level block: name what requires the mechanism in a
 * `[mechanism]` line (a request sentence verbatim, a pinned row, or none); none requires it -> remove it and restore the
 * base behaviour; only a row requires it -> `[pin-doubt]` (the framework re-derives the row); a request sentence
 * requires it -> fix the whole mechanism with one generated test over every kind it touches. The managed worker asks
 * for a missing or unverifiable `[mechanism]` line in the same session (core/repair-report-lines.ts).
 *
 * Lab lean, item 5 (run106-analysis.md §4-§5; switch `remediation.familyEvidence`, default on, `off` = the tag-only
 * rule above): run 106 repaired ONE defect family six rounds in a row because the family was known only from reviewer
 * `[regression-of]` tags, which reviewers wrote for an arbitrary ancestor or not at all, so the mechanism-level brief
 * fired only in round 6. With the switch on a finding is linked to an EARLIER-round finding by evidence too
 * (familyLinks): a cited line whose last change (git blame at the finding's review head) is the earlier finding's
 * repair commit, both citing lines of the same enclosing definition (each at its own review head), or overlapping
 * cited spans of one file (+- FAMILY_SPAN_SLACK lines). The family is the transitive closure of those links over
 * earlier rounds; from the family's second round (FAMILY_MECHANISM_ROUNDS) the repair brief carries the
 * mechanism-level block and owes the `[mechanism]` line. A same-round duplicate's repro is listed for its canonical's
 * repair (sameRoundDuplicateLines), so one regression test covers both and the framework closes the duplicate by
 * running its own repro instead of a second repair (run 106 F-016/F-017). Prompt only: no finding is skipped, merged
 * or closed by these links; every finding still closes through its own verified repair or coverage run.
 */
import { execFileSync } from 'node:child_process';
import type { Finding } from './types.js';
import { findingRepros, regressionTargets, repairCommitFromResolution } from './resolved-finding-guard.js';
import { recordMechanismRequirement } from './repair-report-lines.js';
import { definitionsOf, findingCitations, type FindingCitation } from './review-delta-round.js';
import { isEarlierReviewRound } from './review-round-order.js';

const DIFF_MAX = 3500;
const DESC_MAX = 240;
const BRIEFS_MAX = 2;

const oneLine = (text: string, max: number): string => {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};
const shortId = (storyId: string, id: string): string => (id.startsWith(`${storyId}:`) ? id.slice(storyId.length + 1) : id);

function repairDiff(gitCwd: string, commit: string): string {
  try {
    const text = execFileSync('git', ['show', '--format=', '--no-renames', '-U2', commit], { cwd: gitCwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 16 * 1024 * 1024 });
    return text.length > DIFF_MAX ? `${text.slice(0, DIFF_MAX)}\n… (diff truncated; read it with \`git show ${commit.slice(0, 12)}\`)` : text;
  } catch { return ''; }
}

/**
 * The regression chain ending at `finding`, oldest first (short ids): each step follows the first `[regression-of]` target
 * that exists in `findings`. One finding = no chain; `[F-001, F-002]` = one link; three or more = a mechanism-level repair.
 */
export function regressionChain(findings: readonly Pick<Finding, 'id' | 'desc'>[], storyId: string, finding: Pick<Finding, 'id' | 'desc'>): string[] {
  const chain: string[] = [finding.id];
  const seen = new Set(chain);
  let current: Pick<Finding, 'id' | 'desc'> | undefined = finding;
  while (current) {
    const next: Pick<Finding, 'id' | 'desc'> | undefined = regressionTargets(current.desc ?? '', storyId).map(id => findings.find(row => row.id === id)).find((row): row is Finding => Boolean(row) && !seen.has(row!.id));
    if (!next) break;
    chain.unshift(next.id);
    seen.add(next.id);
    current = next;
  }
  return chain.map(id => shortId(storyId, id));
}

/** Links from which the repair is mechanism-level (the second `[regression-of]` of one chain). */
export const MECHANISM_CHAIN_LINKS = 2;

/** The mechanism-level block of a chain's repair prompt (run 89 F-010: the third report of one mechanism). */
export function mechanismRepairLines(chain: readonly string[]): string[] {
  return [
    `Mechanism-level repair (framework): this is report ${chain.length} of one mechanism (${chain.join(' -> ')}); each earlier repair fixed one more variant and the next round found the next one. Before patching another variant:`,
    '- Name the mechanism under repair (the function or change those repairs edited) and what requires it, in ONE report line: `[mechanism] <mechanism>: required by request "<verbatim request sentence>"`, or `[mechanism] <mechanism>: required by row <CHK-NNN:lane:i>`, or `[mechanism] <mechanism>: none -> removed`.',
    '- If no request sentence and no row requires it, the repair is to remove the mechanism (and the tests and rows that pin only it), restoring the Story base behaviour for those inputs; do not patch another variant.',
    '- If only a pinned row requires it and the request is silent, keep the Story base behaviour and report `[pin-doubt] <CHK-NNN:lane:i> | base prints: <base output> | request: silent` (the framework re-derives the row).',
    '- If a request sentence requires it, fix the whole mechanism at once with ONE test that iterates over every node / input kind the mechanism touches (generated from the type or kind list, not a hand-picked few).',
    '- A final report without a valid [mechanism] line is asked for it before your run ends.',
  ];
}

/** Lab lean: a cited line within this many lines of another finding's cited span of the same file links them. */
export const FAMILY_SPAN_SLACK = 3;
/** Lab lean: the mechanism-level brief fires once a defect family has verified findings in this many review rounds. */
export const FAMILY_MECHANISM_ROUNDS = 2;
const FAMILY_MAX_DEPTH = 8;

export type FamilyLinkVia = 'tag' | 'repair-lines' | 'span' | 'function';
/** One earlier-round finding a finding is linked to, by the strongest evidence (tag > repair-lines > span > function). */
export interface FamilyLink { findingId: string; via: FamilyLinkVia; detail: string }
type FamilyFinding = Pick<Finding, 'id' | 'desc' | 'files' | 'status' | 'reviewRound' | 'reviewRunId' | 'evidenceState' | 'resolvedReason' | 'resolutionType'>;
/** The commit a finding was raised on (its ReviewRun's head); null = unknown (HEAD is read instead). */
export type ReviewHeadOf = (finding: Pick<Finding, 'id' | 'reviewRound' | 'reviewRunId'>) => string | null;

/** A ReviewHeadOf from the Story's ReviewRuns. */
export function reviewHeadResolver(runs: ReadonlyArray<{ reviewRunId: string; headHash?: string | null }>): ReviewHeadOf {
  const heads = new Map(runs.map(run => [run.reviewRunId, run.headHash ?? null] as const));
  return finding => (finding.reviewRunId ? heads.get(finding.reviewRunId) ?? null : null);
}

const samePath = (a: string, b: string): boolean => a === b || a.endsWith(`/${b}`) || b.endsWith(`/${a}`);

function gitOut(gitCwd: string, args: string[]): string | null {
  try { return execFileSync('git', args, { cwd: gitCwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 16 * 1024 * 1024, timeout: 15_000 }); } catch { return null; }
}

/** Per-call caches (a family is computed for one repair launch). */
interface FamilyCache { files: Map<string, string[] | null>; blame: Map<string, string | null>; links: Map<string, FamilyLink[]> }
const newCache = (): FamilyCache => ({ files: new Map(), blame: new Map(), links: new Map() });

function fileLines(cache: FamilyCache, gitCwd: string, head: string, path: string): string[] | null {
  const key = `${head}:${path}`;
  if (!cache.files.has(key)) cache.files.set(key, gitOut(gitCwd, ['show', `${head}:${path}`])?.split('\n') ?? null);
  return cache.files.get(key) ?? null;
}

/** The name of the definition enclosing a line of a file at a commit (definition-line scan), or null. */
function enclosingDefinition(cache: FamilyCache, gitCwd: string, head: string, path: string, line: number): string | null {
  const lines = fileLines(cache, gitCwd, head, path);
  if (!lines) return null;
  return definitionsOf(lines).find(def => def.startLine <= line && line <= def.endLine)?.name ?? null;
}

/** The commit that last changed a line at `head` (git blame), or null. */
function blameCommit(cache: FamilyCache, gitCwd: string, head: string, path: string, line: number): string | null {
  const key = `${head}:${path}:${line}`;
  if (!cache.blame.has(key)) {
    const out = gitOut(gitCwd, ['blame', '--porcelain', '-L', `${line},${line}`, head, '--', path]);
    cache.blame.set(key, out?.match(/^([0-9a-f]{40})\s/)?.[1] ?? null);
  }
  return cache.blame.get(key) ?? null;
}

const lineCitations = (finding: Pick<Finding, 'desc' | 'files'>): Array<FindingCitation & { startLine: number; endLine: number }> =>
  findingCitations(finding).filter((row): row is FindingCitation & { startLine: number; endLine: number } => row.startLine !== null);

function linksOf(cache: FamilyCache, args: { findings: readonly FamilyFinding[]; storyId: string; finding: FamilyFinding; gitCwd: string; reviewHead?: ReviewHeadOf }): FamilyLink[] {
  const { finding, storyId, gitCwd } = args;
  const cached = cache.links.get(finding.id);
  if (cached) return cached;
  const round = finding.reviewRound;
  const out: FamilyLink[] = [];
  if (round) {
    const tagged = new Set(regressionTargets(finding.desc ?? '', storyId));
    const mine = lineCitations(finding);
    const myHead = args.reviewHead?.(finding) ?? 'HEAD';
    const earlier = args.findings.filter(other => other.id !== finding.id && other.status !== 'dismissed' && other.evidenceState !== 'disproven'
      && typeof other.reviewRound === 'string' && isEarlierReviewRound(other.reviewRound, round));
    for (const other of earlier) {
      const theirs = lineCitations(other);
      if (tagged.has(other.id)) { out.push({ findingId: other.id, via: 'tag', detail: `[regression-of ${shortId(storyId, other.id)}]` }); continue; }
      const repair = other.status === 'resolved' ? repairCommitFromResolution(gitCwd, other) : null;
      const byRepair = repair ? mine.find(cite => blameCommit(cache, gitCwd, myHead, cite.path, cite.startLine) === repair) : undefined;
      if (byRepair) { out.push({ findingId: other.id, via: 'repair-lines', detail: `${byRepair.path}:${byRepair.startLine} was last changed by ${shortId(storyId, other.id)}'s repair ${repair!.slice(0, 12)}` }); continue; }
      const span = mine.flatMap(cite => theirs.filter(row => samePath(row.path, cite.path)
        && cite.startLine <= row.endLine + FAMILY_SPAN_SLACK && row.startLine <= cite.endLine + FAMILY_SPAN_SLACK).map(row => ({ cite, row })))[0];
      if (span) { out.push({ findingId: other.id, via: 'span', detail: `${span.cite.path}:${span.cite.startLine} overlaps ${shortId(storyId, other.id)}'s ${span.row.path}:${span.row.startLine}` }); continue; }
      const theirHead = args.reviewHead?.(other) ?? 'HEAD';
      const fn = mine.flatMap(cite => {
        const name = enclosingDefinition(cache, gitCwd, myHead, cite.path, cite.startLine);
        return name ? theirs.filter(row => samePath(row.path, cite.path) && enclosingDefinition(cache, gitCwd, theirHead, row.path, row.startLine) === name).map(() => ({ cite, name })) : [];
      })[0];
      if (fn) out.push({ findingId: other.id, via: 'function', detail: `${fn.cite.path}:${fn.cite.startLine} and ${shortId(storyId, other.id)} both cite ${fn.name}` });
    }
  }
  cache.links.set(finding.id, out);
  return out;
}

/**
 * Lab lean (remediation.familyEvidence): the earlier-round findings `finding` is linked to, one entry per finding with
 * its strongest evidence. Findings of the same or a later round, dismissed and disproven findings are never linked.
 */
export function familyLinks(args: { findings: readonly FamilyFinding[]; storyId: string; finding: FamilyFinding; gitCwd: string; reviewHead?: ReviewHeadOf }): FamilyLink[] {
  return linksOf(newCache(), args);
}

/** The defect family of a finding over earlier rounds (transitive closure of familyLinks): its members and their rounds. */
export function findingFamily(args: { findings: readonly FamilyFinding[]; storyId: string; finding: FamilyFinding; gitCwd: string; reviewHead?: ReviewHeadOf }, cache: FamilyCache = newCache()):
  { members: FamilyFinding[]; rounds: string[]; links: FamilyLink[] } {
  const members = new Map<string, FamilyFinding>([[args.finding.id, args.finding]]);
  let frontier: FamilyFinding[] = [args.finding];
  const direct = linksOf(cache, args);
  for (let depth = 0; frontier.length && depth < FAMILY_MAX_DEPTH; depth += 1) {
    const next: FamilyFinding[] = [];
    for (const row of frontier) {
      for (const link of linksOf(cache, { ...args, finding: row })) {
        const linked = args.findings.find(other => other.id === link.findingId);
        if (linked && !members.has(linked.id)) { members.set(linked.id, linked); next.push(linked); }
      }
    }
    frontier = next;
  }
  const rounds = [...new Set([...members.values()].map(row => row.reviewRound).filter((row): row is string => typeof row === 'string'))];
  return { members: [...members.values()], rounds, links: direct };
}

/** The chain shown in the mechanism block: the family's members in round order, ending at the finding. */
function familyChain(storyId: string, family: { members: FamilyFinding[] }, finding: FamilyFinding): string[] {
  const order = family.members.filter(row => row.id !== finding.id).sort((a, b) => (isEarlierReviewRound(a.reviewRound ?? '', b.reviewRound ?? '') ? -1
    : isEarlierReviewRound(b.reviewRound ?? '', a.reviewRound ?? '') ? 1 : a.id.localeCompare(b.id)));
  return [...order.map(row => shortId(storyId, row.id)), shortId(storyId, finding.id)];
}

/**
 * Record the `[mechanism]` line a chain finding's repair owes (read by the managed worker's report follow-up) when the
 * chain has at least MECHANISM_CHAIN_LINKS links and the brief carries the block. Lab lean (familyEvidence): also when
 * the finding's evidence family spans FAMILY_MECHANISM_ROUNDS rounds and holds a resolved finding. Returns whether it was recorded.
 */
export function recordChainMechanismRequirement(args: { root: string; storyId: string; findings: readonly Finding[]; finding: Pick<Finding, 'id' | 'desc'> & Partial<FamilyFinding>; requestText: string | null;
  gitCwd?: string; reviewHead?: ReviewHeadOf; familyEvidence?: boolean }): boolean {
  if (args.familyEvidence && args.gitCwd) {
    const finding = { ...args.finding } as FamilyFinding;
    const family = findingFamily({ findings: args.findings, storyId: args.storyId, finding, gitCwd: args.gitCwd, reviewHead: args.reviewHead });
    if (family.rounds.length >= FAMILY_MECHANISM_ROUNDS && family.members.some(row => row.id !== finding.id && row.status === 'resolved')) {
      recordMechanismRequirement(args.root, args.storyId, { findingId: args.finding.id, chain: familyChain(args.storyId, family, finding), requestText: args.requestText });
      return true;
    }
  }
  const earlier = regressionTargets(args.finding.desc ?? '', args.storyId).some(id => args.findings.some(row => row.id === id && row.status === 'resolved'));
  const chain = regressionChain(args.findings, args.storyId, args.finding);
  if (!earlier || chain.length - 1 < MECHANISM_CHAIN_LINKS) return false;
  recordMechanismRequirement(args.root, args.storyId, { findingId: args.finding.id, chain, requestText: args.requestText });
  return true;
}

/**
 * The brief lines for one finding; empty when it names no resolved finding with a repair commit. Lab lean
 * (familyEvidence): the earlier findings are its tagged ones plus those linked by evidence (familyLinks), and the
 * mechanism-level block comes from the family's second round on.
 */
export function regressionFamilyBrief(args: { findings: readonly Finding[]; storyId: string; finding: Pick<Finding, 'id' | 'desc'> & Partial<FamilyFinding>; gitCwd: string;
  reviewHead?: ReviewHeadOf; familyEvidence?: boolean }): string[] {
  const { storyId, finding } = args;
  const cache = newCache();
  const family = args.familyEvidence ? findingFamily({ findings: args.findings, storyId, finding: finding as FamilyFinding, gitCwd: args.gitCwd, reviewHead: args.reviewHead }, cache) : null;
  const tagged = regressionTargets(finding.desc ?? '', storyId)
    .map(id => args.findings.find(row => row.id === id && row.status === 'resolved'))
    .filter((row): row is Finding => Boolean(row));
  const linked = (family?.links ?? []).filter(link => link.via !== 'tag')
    .map(link => ({ link, row: args.findings.find(row => row.id === link.findingId && row.status === 'resolved') }))
    .filter((entry): entry is { link: FamilyLink; row: Finding } => Boolean(entry.row) && !tagged.some(row => row.id === entry.row!.id));
  const earlier = [...tagged, ...linked.map(entry => entry.row)].slice(0, BRIEFS_MAX);
  if (!earlier.length) return [];
  const evidence = linked.filter(entry => earlier.includes(entry.row)).map(entry => entry.link.detail);
  const lines: string[] = [`Family-complete repair (${shortId(storyId, finding.id)} re-found ${earlier.map(row => shortId(storyId, row.id)).join(', ')}, so the earlier repair did not cover this case${evidence.length ? `; linked by evidence: ${evidence.join('; ')}` : ''}):`];
  for (const row of earlier) {
    const repros = findingRepros(row.desc).repros;
    lines.push(`- ${shortId(storyId, row.id)} (resolved): ${oneLine(row.desc, DESC_MAX)}${repros.length ? ` Repro: ${repros.map(repro => `\`${repro}\``).join(', ')}` : ''}`);
    const commit = repairCommitFromResolution(args.gitCwd, row);
    const diff = commit ? repairDiff(args.gitCwd, commit) : '';
    if (diff.trim()) lines.push(`- ${shortId(storyId, row.id)}'s repair ${commit!.slice(0, 12)}, as committed (it fixed the case it listed, not this one):`, '```diff', diff.trimEnd(), '```');
  }
  lines.push('- Treat that diff as the earlier attempt at THIS mechanism, not as its fix. Before editing, list every call site and every target shape of the mechanism it changed (grep the function and each of its callers; include the computed, nested, negative and edge variants of the same call).');
  lines.push('- Add ONE test that covers every call site and every target shape of the mechanism: the earlier finding\'s repro, this finding\'s repro and each shape you found. Run it before you commit.');
  lines.push('- In your final report add one line `[family-test] <test name>: <shape>, <shape>, ...` listing what that test covers.');
  // Lab run89 (fix 3): from the second [regression-of] link on, the repair is about the mechanism, not the next variant.
  // Lab lean (familyEvidence): from the family's second round on (FAMILY_MECHANISM_ROUNDS), tagged or not.
  const chain = regressionChain(args.findings, storyId, finding);
  if (family && family.rounds.length >= FAMILY_MECHANISM_ROUNDS) lines.push(...mechanismRepairLines(familyChain(storyId, family, finding as FamilyFinding)));
  else if (chain.length - 1 >= MECHANISM_CHAIN_LINKS) lines.push(...mechanismRepairLines(chain));
  return lines;
}

/**
 * Lab lean (run 106 F-016/F-017: a duplicate of the round's canonical got a second repair because the canonical's
 * test did not run its repro): the open same-round duplicates of `finding` (duplicateOf gives a finding's canonical
 * root) with their repros, for the canonical's repair to cover in its regression test. The duplicate still closes
 * only through the framework's coverage run of its own repro (or its own repair when that fails).
 */
export function sameRoundDuplicateLines(args: { storyId: string; finding: Pick<Finding, 'id' | 'reviewRound'>; findings: ReadonlyArray<Pick<Finding, 'id' | 'desc' | 'status' | 'reviewRound'>>;
  duplicateOf: (findingId: string) => string | null }): string[] {
  const { storyId, finding } = args;
  const dups = args.findings.filter(row => row.id !== finding.id && row.status === 'open' && row.reviewRound === finding.reviewRound && args.duplicateOf(row.id) === finding.id);
  if (!dups.length) return [];
  return [
    `Same-round duplicates of ${shortId(storyId, finding.id)} (the same defect reported again this round): make your regression test also run each repro below, so the framework closes each duplicate by running it against your fix instead of a second repair:`,
    ...dups.map(row => {
      const repros = findingRepros(row.desc).repros;
      return `- ${shortId(storyId, row.id)}: ${oneLine(row.desc, DESC_MAX)}${repros.length ? ` Repro: ${repros.map(repro => `\`${repro}\``).join(', ')}` : ''}`;
    }),
  ];
}
