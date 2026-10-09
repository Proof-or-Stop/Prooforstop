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
  assessFindingBasePresence, findingScopeCoverage, findingSites,
  type FindingBasePresence, type FindingScopeCoverage,
} from '../core/finding-preexisting.js';

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
  const presence = assessFindingBasePresence({ gitCwd, base, head, finding });
  return { eligible: presence.preExisting, coverage, presence,
    reason: presence.preExisting ? `pre-existing at the Story base and outside the Story: ${presence.reason}; ${coverage.reason}` : `not pre-existing: ${presence.reason}` };
}
