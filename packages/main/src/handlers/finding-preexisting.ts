/**
 * Old-PoS run 30 (B-c201:F-005): the store-aware half of
 * core/finding-preexisting.ts. Reads the Story's scope contract, checklist
 * files, scope boundary, verbatim request and Git base/head, and returns
 * whether one open finding is pre-existing at the Story base AND outside the
 * Story's request/scope (then next closes it by one audited disposition
 * instead of routing it to repair). Shared by next, finding_resolve
 * disposition=preexisting_out_of_scope and finding_applicability_assess
 * (verdict pre_existing_unaffected / out_of_scope with proposalRef = the
 * finding id), so the three always agree.
 */
import { execFileSync } from 'node:child_process';
import type { StoryStore } from '../core/store.js';
import type { Finding } from '../core/types.js';
import { itemDeclaredFiles } from '../core/ab-dispatch-grouping.js';
import { resolveFullStoryBaseHead } from '../core/review-incremental-context.js';
import { resolveStoryMergeBase } from '../core/story-change-manifest.js';
import { resolveGitCwd } from '../core/story-signed-workspace-resolution.js';
import { readStoryRequest } from '../core/story-request.js';
import {
  assessFindingBasePresence, findingScopeCoverage, findingSites, PREEXISTING_OUT_OF_SCOPE, recurringPreexistingSites,
  type BaseBehaviourVerdict, type FindingBasePresence, type FindingScopeCoverage, type RecurringPreexistingMatch,
} from '../core/finding-preexisting.js';
import { pathMatchesScopePattern } from '../core/scope-path-classifier.js';
import { evaluateInTree, normalizeProbeValue, prepareHeadTree, probeProgram, storyProbeRunner } from '../core/request-probes.js';
import { findingRepros, isReproCommand } from '../core/resolved-finding-guard.js';
import { driftBaseSymbolOn } from '../core/ab-variants.js';
import { loadConfig } from '../core/config.js';

/**
 * Lab run110 (run110-analysis.md §6 fix 2): the base behaviour of a drift's contrasted code. The finding's own repro
 * (its `Repro:` spans, else its probe-like code spans) runs on the Story base and on HEAD with the project's declared
 * probe runner (core/request-probes.ts storyProbeRunner: the base commit's proof-or-stop.config.json probeRunner).
 * Every repro answering the same at both: `same` (the behaviour the doc contradicts predates the Story); any repro
 * answering differently: `changed`; no runner, no repro, or a repro either side cannot run: `unknown`.
 * Hardening is the existing base-probe path, nothing new: runner command forms (`go test ...`, `sh -c ...`) are dropped
 * (isReproCommand); each repro is program TEXT written to a file inside the archived temp tree and passed as one argv
 * element to the project's declared runner (spawnSync, no shell), with the runner's timeout, evaluation cap and
 * result cache (core/request-probes.ts evaluateInTree, as plan.pinProbe and the probe tables use it).
 */
export function driftBaseBehaviour(args: { store: StoryStore; root: string; storyId: string; gitCwd: string; desc: string }): BaseBehaviourVerdict {
  const repros = findingRepros(args.desc).repros.filter(repro => !isReproCommand(repro));
  if (!repros.length) return { verdict: 'unknown', detail: 'the finding states no repro' };
  const runner = storyProbeRunner(args.store, args.root, args.storyId, args.gitCwd);
  if (!runner) return { verdict: 'unknown', detail: 'no project probe runner is declared' };
  const head = prepareHeadTree(runner);
  if (!head) return { verdict: 'unknown', detail: 'the HEAD tree could not be prepared' };
  const programs = repros.map(repro => probeProgram(runner.config, [], repro));
  const atBase = evaluateInTree(runner, runner.baseTree, programs);
  const atHead = evaluateInTree(runner, head.tree, programs);
  const rows = repros.map((repro, index) => ({ repro, base: atBase.get(programs[index]!), head: atHead.get(programs[index]!) }));
  const unrunnable = rows.find(row => !row.base || !row.head || row.base.status === 'unrunnable' || row.head.status === 'unrunnable');
  if (unrunnable) return { verdict: 'unknown', detail: `\`${unrunnable.repro}\` cannot run on both trees` };
  const differs = rows.find(row => row.base!.status !== row.head!.status || normalizeProbeValue(row.base!.text) !== normalizeProbeValue(row.head!.text));
  if (differs) return { verdict: 'changed', detail: `\`${differs.repro}\`: base ${differs.base!.text.slice(0, 80)} vs HEAD ${differs.head!.text.slice(0, 80)}` };
  return { verdict: 'same', detail: rows.map(row => `\`${row.repro}\` -> ${row.head!.text.slice(0, 60)}`).join(', ') + ` at base ${runner.base.slice(0, 12)} and HEAD ${head.head.slice(0, 12)}` };
}

export interface PreexistingFindingVerdict {
  /** Pre-existing at the Story base and outside the Story's request/scope: closable by the audited disposition. */
  eligible: boolean;
  coverage: FindingScopeCoverage | null;
  presence: FindingBasePresence | null;
  /** Why it is (not) eligible, one line. */
  reason: string;
}

function revParse(gitCwd: string, ref: string): string | null {
  try { return execFileSync('git', ['rev-parse', '--verify', `${ref}^{commit}`], { cwd: gitCwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null; } catch { return null; }
}

function isAncestor(gitCwd: string, commit: string): boolean {
  try { execFileSync('git', ['merge-base', '--is-ancestor', commit, 'HEAD'], { cwd: gitCwd, stdio: 'ignore' }); return true; } catch { return false; }
}

/**
 * The verdict for one finding. Cheap first: a finding that cites no
 * `path:line` defect site, or whose cited defect files the Story's scope
 * covers, never reaches Git. For a doc-code-drift finding the defect sites are
 * its documentation anchors (core/finding-preexisting.ts findingSites).
 */
export function evaluatePreexistingFinding(args: { store: StoryStore; root: string; storyId: string; finding: Finding }): PreexistingFindingVerdict {
  const { store, root, storyId, finding } = args;
  // Old-PoS runs 36/37: a doc-code-drift finding's code anchors are evidence, not defect sites.
  const anchors = findingSites(finding).defects;
  if (anchors.length === 0) return { eligible: false, coverage: null, presence: null, reason: 'the finding cites no path:line defect site' };
  const paths = [...new Set(anchors.map(anchor => anchor.path))];
  const request = readStoryRequest(store, storyId);
  let itemFiles: string[] = [];
  try { itemFiles = store.readChecklist(storyId).items.flatMap(item => itemDeclaredFiles(item)); } catch { itemFiles = []; }
  let scopeAllowed: string[] = [];
  try { scopeAllowed = store.readScopeBoundary(storyId)?.allowed ?? []; } catch { scopeAllowed = []; }
  const coverage = findingScopeCoverage({ paths, contract: store.readScopeContract(storyId), itemFiles,
    requestText: request.status === 'ok' ? request.text : null, scopeAllowed });
  if (coverage.inScope) return { eligible: false, coverage, presence: null, reason: `in the Story's scope: ${coverage.reason}` };
  const gitCwd = resolveGitCwd({ store, storyId, metadataRoot: root, projectRoot: root });
  let base: string | undefined;
  try { base = resolveFullStoryBaseHead(store, root, storyId); } catch { base = undefined; }
  base ??= resolveStoryMergeBase(gitCwd, 'HEAD');
  if (!base) return { eligible: false, coverage, presence: null, reason: 'the Story base could not be resolved' };
  const reviewed = finding.managedEvidenceBinding?.headHash;
  const head = (reviewed && isAncestor(gitCwd, reviewed) ? reviewed : null) ?? revParse(gitCwd, 'HEAD');
  if (!head) return { eligible: false, coverage, presence: null, reason: 'HEAD could not be resolved' };
  // Lab run110: an excluded doc's edit is a refused scope violation; the contrasted code is judged by base behaviour.
  const contract = store.readScopeContract(storyId);
  const excludes = [...(contract?.explicitExcludes ?? []), ...(contract?.protectedFiles ?? [])];
  let symbolFallback = false;
  try { symbolFallback = driftBaseSymbolOn(loadConfig(root)); } catch { symbolFallback = false; }
  let behaviour: BaseBehaviourVerdict | undefined;
  const presence = assessFindingBasePresence({ gitCwd, base, head, finding, symbolFallback,
    excluded: path => excludes.some(pattern => pathMatchesScopePattern(path, pattern)),
    baseBehaviour: () => (behaviour ??= (() => {
      try { return driftBaseBehaviour({ store, root, storyId, gitCwd, desc: finding.desc ?? '' }); } catch (error) {
        return { verdict: 'unknown' as const, detail: `base probe failed: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}` };
      }
    })()) });
  return { eligible: presence.preExisting, coverage, presence,
    reason: presence.preExisting ? `pre-existing at the Story base and outside the Story: ${presence.reason}; ${coverage.reason}` : `not pre-existing: ${presence.reason}` };
}

export interface RecurringPreexistingVerdict extends RecurringPreexistingMatch {
  /** The candidate's own pre-existing verdict (base evidence + scope), when it was computed. */
  verdict: PreexistingFindingVerdict | null;
}

/**
 * Old-PoS run 52 (bench-staging/oldpos/run52-analysis.md §4): whether a newly
 * imported finding re-files a site an earlier `preexisting_out_of_scope`
 * disposition of this Story already covers. The candidate must pass the same
 * check a disposition passes (evaluatePreexistingFinding: base presence, scope
 * coverage), every disposition is re-checked on the current material, and every
 * candidate site must be one of theirs (core/finding-preexisting.ts
 * recurringPreexistingSites). Cheap first: no Git unless a dispositioned
 * finding shares a cited path.
 */
export function evaluateRecurringPreexistingFinding(args: { store: StoryStore; root: string; storyId: string; finding: Finding;
  findings?: readonly Finding[] }): RecurringPreexistingVerdict {
  const { store, root, storyId, finding } = args;
  const sites = findingSites(finding).defects;
  const no = (reason: string, verdict: PreexistingFindingVerdict | null = null): RecurringPreexistingVerdict =>
    ({ recurring: false, of: [], sites: sites.map(anchor => `${anchor.path}:${anchor.line}`), reason, verdict });
  if (sites.length === 0) return no('the finding cites no path:line defect site');
  const all = args.findings ?? store.readFindings(storyId).findings ?? [];
  const paths = new Set(sites.map(anchor => anchor.path));
  const dispositioned = all.filter(row => row.id !== finding.id && row.status === 'resolved' && row.resolutionType === PREEXISTING_OUT_OF_SCOPE
    && findingSites(row).defects.some(anchor => paths.has(anchor.path)));
  if (dispositioned.length === 0) return no('no pre-existing disposition of this Story cites the same file');
  const verdict = evaluatePreexistingFinding({ store, root, storyId, finding });
  if (!verdict.eligible || !verdict.presence) return no(verdict.reason, verdict);
  const holding = dispositioned.flatMap(row => {
    const own = evaluatePreexistingFinding({ store, root, storyId, finding: row });
    return own.eligible && own.presence ? [{ findingId: row.id, presence: own.presence }] : [];
  });
  return { ...recurringPreexistingSites({ candidate: verdict.presence, dispositioned: holding }), verdict };
}
