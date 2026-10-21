/**
 * Lab run131: the store-aware half of core/finding-conflict-settle.ts. Reads the Story's process events (rejected
 * repairs), findings, checklist, verbatim request and the settled-pair journal, and returns the framework's decision for
 * one open finding's conflict with a resolved finding (shared by next's framework step `finding_conflict_settled`, the
 * conflict step that would otherwise send it to PLAN, and finding_resolve disposition=finding_conflict_settled, so all
 * agree). With remediation.conflictSettle=off nothing is settled by the checklist pin.
 *
 * Lab run137 (fix N, core/finding-conflict-pin.ts, remediation.conflictPin): a conflict no checklist row pins is decided
 * by the framework pin when the request, or the open finding's stated Story base value confirmed by a fresh run of the
 * Story's base evaluator (freshBaseProbe), decides it (evaluateFrameworkConflictPin):
 *   - the open finding wins (`story_base` / `request`): it is repaired against the pin (no PLAN trip), and the framework's
 *     own `[regression-of G]` finding that blames its rejected repair is the losing side: settled here;
 *   - the resolved finding wins (`request`): the open finding is settled here.
 */
import type { StoryStore } from '../core/store.js';
import type { Finding } from '../core/types.js';
import { conflictPinOn, conflictSettleOn } from '../core/ab-variants.js';
import { loadConfig } from '../core/config.js';
import { readStoryRequest } from '../core/story-request.js';
import { resolveGitCwd } from '../core/story-signed-workspace-resolution.js';
import { findingDuplicateOf } from '../core/duplicate-finding-coverage.js';
import { findingConflictOf, findingGuard, findingRepros, guardStatesPins, isReproCommand, regressionTargets, rejectedRepairCommits, repairCommitFromResolution, rowsCitingCase } from '../core/resolved-finding-guard.js';
import { conflictSettlements, findingConflictSettlement, FINDING_CONFLICT_PRECEDENCE, FINDING_CONFLICT_REASON_PREFIX, type ConflictSettlement } from '../core/finding-conflict-settle.js';
import { frameworkConflictPin, frameworkPinConfirmed, type FrameworkConflictPin } from '../core/finding-conflict-pin.js';
import { isTestPath } from '../core/probe-text.js';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pinOracleStoryBase, prepareArchivedTree, readBasePinOracle } from '../core/pin-oracle.js';
import { evaluateInTree, normalizeProbeValue, probeProgram, readBaseProbeRunner, type ProbeRunnerConfig } from '../core/request-probes.js';

/** The settlement for one open finding, or null (switch off, no conflict, or not the framework's to decide). */
export function evaluateFindingConflictSettlement(args: { store: StoryStore; root: string; storyId: string; finding: Finding; findings?: readonly Finding[];
  gitCwd?: string; events?: ReadonlyArray<Record<string, unknown>> }): ConflictSettlement | null {
  const { store, root, storyId, finding } = args;
  let settleOn = true;
  try { settleOn = conflictSettleOn(loadConfig(root)); } catch { /* unreadable config: the production default (on) */ }
  try {
    const findings = args.findings ?? store.readFindings(storyId).findings ?? [];
    let events = args.events;
    if (!events) { try { events = store.readProcessEvents(storyId) as Array<Record<string, unknown>>; } catch { events = []; } }
    const conflict = findingConflictOf({ finding, findings, storyId, rejected: rejectedRepairCommits(events),
      duplicateOf: id => findingDuplicateOf(store, storyId, id)?.canonicalFindingId ?? null });
    // Lab run137 (remediation.conflictPin, its own switch): the framework regression finding of an upheld repair.
    if (!conflict?.resolvedId) return regressionOfFrameworkPin({ store, root, storyId, finding, findings, events, gitCwd: args.gitCwd });
    const guarded = findings.find(row => row.id === conflict.resolvedId);
    if (!guarded) return null;
    const gitCwd = args.gitCwd ?? resolveGitCwd({ store, storyId, metadataRoot: root, projectRoot: root });
    const items = store.readChecklist(storyId).items;
    let coverage = null;
    try { coverage = store.readDuplicateFindingCoverage(storyId).receipts.filter(row => row.findingId === guarded.id && row.passed).at(-1) ?? null; } catch { coverage = null; }
    const guard = findingGuard({ gitCwd, finding: guarded, repairCommit: repairCommitFromResolution(gitCwd, guarded), coverage });
    const pins = guard ? guardStatesPins(gitCwd, guard, items) : null;
    const repros = findingRepros(finding.desc).repros.filter(repro => !isReproCommand(repro));
    const request = readStoryRequest(store, storyId);
    const settled = !settleOn ? null : findingConflictSettlement({ finding, conflict, guarded, pins, items: items as never, requestText: request.status === 'ok' ? request.text : null,
      repros: repros.length ? repros : (guard?.repros ?? []), settledCases: conflictSettlements(root, storyId) });
    if (settled) return settled;
    // Lab run137: no row pins the case; the request decides it for the resolved finding's side: this one loses.
    const framework = evaluateFrameworkConflictPin({ store, root, storyId, finding, findings, events, gitCwd });
    if (framework?.pin.side !== 'resolved') return null;
    return frameworkPinSettlement(finding, framework.resolved, framework.pin, `${short(finding.id)} demands the opposite of resolved ${short(framework.resolved.id)} (${conflict.why})`);
  } catch {
    return null;
  }
}

const short = (id: string): string => id.replace(/^[^:]+:(?=F-)/, '');

function frameworkPinSettlement(loser: Pick<Finding, 'id'>, resolved: Pick<Finding, 'id'>, pin: FrameworkConflictPin, what: string): ConflictSettlement {
  const cases = pin.cases.map(row => row.expr);
  const reason = `${FINDING_CONFLICT_REASON_PREFIX} ${what} for ${cases.map(row => `\`${row}\``).join(', ')}. No checklist row pins ${cases.length > 1 ? 'these cases' : 'this case'}; decided once by the framework pin `
    + `(precedence ${FINDING_CONFLICT_PRECEDENCE}, source ${pin.source}): ${pin.reason}. ${short(loser.id)} is the losing side: closed without a repair; severity unchanged. `
    + `A pin of the case in PLAN (re-pin: <case> was <old>, now <new>) reopens it.`;
  return { settle: true, winner: pin.source, reason, cases, resolvedId: resolved.id };
}

/**
 * Lab run137: the framework pin of one open finding's conflict with a resolved finding that no current checklist row pins
 * (a row that pins it decides instead), or null (switch off, no such conflict, or not determinable: the PLAN pin stays).
 * The base probe is the Story's declared evaluator run in a fresh private tree (freshBaseProbe); a stated base value counts
 * only when it ran and printed that value for every case.
 */
export function evaluateFrameworkConflictPin(args: { store: StoryStore; root: string; storyId: string; finding: Finding; findings?: readonly Finding[];
  gitCwd?: string; events?: ReadonlyArray<Record<string, unknown>> }): { pin: FrameworkConflictPin; resolved: Finding } | null {
  const { store, root, storyId, finding } = args;
  try { if (!conflictPinOn(loadConfig(root))) return null; } catch { /* unreadable config: the production default (on) */ }
  try {
    const findings = args.findings ?? store.readFindings(storyId).findings ?? [];
    let events = args.events;
    if (!events) { try { events = store.readProcessEvents(storyId) as Array<Record<string, unknown>>; } catch { events = []; } }
    const conflict = findingConflictOf({ finding, findings, storyId, rejected: rejectedRepairCommits(events),
      duplicateOf: id => findingDuplicateOf(store, storyId, id)?.canonicalFindingId ?? null });
    if (!conflict?.resolvedId) return null;
    const resolved = findings.find(row => row.id === conflict.resolvedId);
    if (!resolved) return null;
    const items = store.readChecklist(storyId).items;
    const repros = findingRepros(finding.desc).repros.filter(repro => !isReproCommand(repro));
    if (repros.length && rowsCitingCase(items, repros).length) return null;
    const request = readStoryRequest(store, storyId);
    const gitCwd = args.gitCwd ?? resolveGitCwd({ store, storyId, metadataRoot: root, projectRoot: root });
    const requestText = request.status === 'ok' ? request.text : null;
    const base = freshBaseProbe(store, storyId, gitCwd);
    let pin: FrameworkConflictPin | null;
    try {
      pin = frameworkConflictPin({ finding, resolved, conflict, requestText, ...(base ? { baseProbe: base.probe } : {}),
        trustedTexts: trustedProbeSources({ gitCwd, requestText, items, resolved }) });
    } finally {
      base?.dispose();
    }
    // Security review: nothing is decided without a positive confirmation record of every case.
    if (!pin || !frameworkPinConfirmed(pin)) return null;
    // A case a current row pins is the row's to decide (lab run131 settle / the repair against the row).
    if (rowsCitingCase(items, pin.cases.map(row => row.expr)).length) return null;
    return { pin, resolved };
  } catch {
    return null;
  }
}

/**
 * Lab run137: the framework's own regression finding `[regression-of G] the repair of F (commit c) broke ...` is the
 * losing side when the framework pin of F's conflict with G upholds F (the repair broke a test that pins a value the
 * request / the Story base do not support). Linked by the rejected-repair record of G's guard, never by prose alone.
 */
function regressionOfFrameworkPin(args: { store: StoryStore; root: string; storyId: string; finding: Finding; findings: readonly Finding[];
  events: ReadonlyArray<Record<string, unknown>>; gitCwd?: string }): ConflictSettlement | null {
  const { storyId, finding, findings } = args;
  const targets = regressionTargets(finding.desc, storyId);
  const blamed = String(finding.desc ?? '').match(/^\[regression-of [^\]]+\] the repair of ([^ ]+) \(commit ([0-9a-f]{7,40})\)/);
  if (!targets.length || !blamed) return null;
  const rejected = rejectedRepairCommits(args.events);
  for (const [findingId, rows] of rejected) {
    if (short(findingId) !== blamed[1] || !rows.some(row => targets.includes(row.guardedFindingId) && row.commit.startsWith(blamed[2]!))) continue;
    const owner = findings.find(row => row.id === findingId && row.status === 'open');
    if (!owner) continue;
    const framework = evaluateFrameworkConflictPin({ ...args, finding: owner, findings });
    if (framework?.pin.side !== 'finding' || !targets.includes(framework.resolved.id)) continue;
    // Security review: a framework guard finding is settled only on a positive confirmation record (a request-quoted value,
    // or the Story base evaluator's own output for an expression a trusted source names or the strict grammar admits),
    // never on what the finding (a reviewer) wrote.
    if (!frameworkPinConfirmed(framework.pin)) continue;
    return frameworkPinSettlement(finding, framework.resolved, framework.pin,
      `${short(finding.id)} reports that the repair of ${short(owner.id)} broke resolved ${short(framework.resolved.id)}'s covering test`);
  }
  return null;
}

/**
 * Lab run137 (security review 2 of fix N): the texts a probed case expression must appear in, or whose calls it may use
 * (core/finding-conflict-pin.ts probeExprTrust): the request, the checklist rows' own text (title, userSees, intent row
 * desc / derivation), and the test files of the resolved finding's recorded repair commit as committed there (git, not
 * the work tree). Never the open finding's text.
 */
function trustedProbeSources(args: { gitCwd: string; requestText: string | null; items: ReadonlyArray<{ title?: unknown; userSees?: unknown; verificationIntent?: unknown }>; resolved: Finding }): string[] {
  const out: string[] = [];
  if (args.requestText) out.push(args.requestText);
  const strings = (value: unknown): void => {
    if (typeof value === 'string') out.push(value);
    else if (Array.isArray(value)) value.forEach(strings);
    else if (value && typeof value === 'object') for (const [key, inner] of Object.entries(value)) if (key !== 'evidence' && key !== 'history') strings(inner);
  };
  for (const item of args.items) strings({ title: item.title, userSees: item.userSees, verificationIntent: item.verificationIntent });
  const commit = (() => { try { return repairCommitFromResolution(args.gitCwd, args.resolved); } catch { return null; } })();
  if (commit && /^[0-9a-f]{7,40}$/.test(commit)) {
    const git = (gitArgs: string[]): string | null => { try { return execFileSync('git', gitArgs, { cwd: args.gitCwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 16 * 1024 * 1024 }); } catch { return null; } };
    const files = (git(['show', '--name-only', '--format=', '--no-renames', commit]) ?? '').split('\n').map(row => row.trim()).filter(path => path && isTestPath(path)).slice(0, 8);
    for (const path of files) { const text = git(['show', `${commit}:${path}`]); if (text !== null) out.push(text); }
  }
  return out;
}

/** Per-process memo of fresh base-probe results (base commit + evaluator config + expression); never persisted. */
const freshProbeResults = new Map<string, string | null>();

/**
 * Lab run137 (security review of fix N): the Story's declared base evaluator, read from the base commit itself (`git
 * show <base>:proof-or-stop.config.json`, probeRunner else pinOracle), run in a FRESH private base tree (git archive into a
 * new temporary directory, removed by dispose). The shared runtime trees and their results.json caches under
 * `.proof-or-stop/runtime/` are owner-writable and are not used for this decision. A probeRunner's declared self-test
 * must pass first. Null when the project declares no evaluator. The tree is built on the first probe only.
 */
export function freshBaseProbe(store: Pick<StoryStore, 'readStory'>, storyId: string, gitCwd: string): { probe: (expr: string) => string | null; dispose: () => void } | null {
  let base: string | null = null;
  let declared: { config: ProbeRunnerConfig; env: Record<string, string>; kind: 'probeRunner' | 'pinOracle' } | null = null;
  try {
    const story = store.readStory(storyId) as { integrationTarget?: { parentCommitAtCreation?: string } };
    base = pinOracleStoryBase(gitCwd, story.integrationTarget?.parentCommitAtCreation);
    if (!base) return null;
    const runner = readBaseProbeRunner(gitCwd, base);
    const oracle = runner ? null : readBasePinOracle(gitCwd, base);
    declared = runner ? { config: runner.config, env: runner.env, kind: 'probeRunner' }
      // A pinOracle's skipPattern marks errors as unrunnable for its own value oracle; here an error is an error.
      : oracle ? { config: { ...oracle.config, skipPattern: undefined } as ProbeRunnerConfig, env: oracle.env, kind: 'pinOracle' } : null;
  } catch { return null; }
  if (!base || !declared) return null;
  const evaluator = declared;
  const key = `${base}|${JSON.stringify(evaluator.config)}`;
  let dir: string | null = null;
  let tree: string | null | undefined;
  const treeOf = (): string | null => {
    if (tree !== undefined) return tree;
    try {
      dir = mkdtempSync(join(tmpdir(), 'pos-conflict-pin-'));
      tree = prepareArchivedTree(join(dir, 'base'), gitCwd, base!, evaluator.config.setup, evaluator.config.timeoutMs, evaluator.env);
      const selfTest = evaluator.kind === 'probeRunner' ? evaluator.config.selfTest : undefined;
      if (tree && selfTest && typeof selfTest.input === 'string' && typeof selfTest.output === 'string') {
        const program = probeProgram(evaluator.config, [], selfTest.input);
        const result = evaluateInTree({ config: evaluator.config, env: evaluator.env }, tree, [program]).get(program);
        if (!result || result.status !== 'value' || normalizeProbeValue(result.text) !== normalizeProbeValue(selfTest.output)) tree = null;
      }
    } catch { tree = null; }
    return tree ?? null;
  };
  return {
    probe: expr => {
      const memo = `${key}|${expr}`;
      if (freshProbeResults.has(memo)) return freshProbeResults.get(memo)!;
      const at = treeOf();
      if (!at) return null;
      const program = probeProgram(evaluator.config, [], expr);
      const observed = evaluateInTree({ config: evaluator.config, env: evaluator.env }, at, [program]).get(program);
      const value = observed?.status === 'value' ? observed.text : null;
      freshProbeResults.set(memo, value);
      return value;
    },
    dispose: () => { if (dir) { try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } } },
  };
}
