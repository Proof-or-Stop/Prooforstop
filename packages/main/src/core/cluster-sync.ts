/**
 * B-e8c8 CHK-005: commit message Resolves: CL-xxx auto-resolves the entire cluster.
 *
 * Design points (see plan.md CHK-005 + decision.json preMortem 1):
 *   - Pure sub-function `applyCommitResolves(findings, clusters, commitMessages)` carries the core logic,
 *     making it easy to test directly in fixtures without a git environment (scratch-first).
 *   - The `syncClusterResolves` shell is responsible for running `git log --format=%H%x00%B main..HEAD` to fetch real commits,
 *     parsing them into `{ sha, message }[]` and feeding them to the pure fn. git failure (non-git dir / no main branch) → zeros.
 *   - Regex /Resolves?:\s+(CL-\d{3})/gi is lenient about case and singular/plural.
 *   - Idempotent: skip findings where finding.status !== 'open' (do not overwrite already resolved/dismissed entries).
 *
 * CHK-010 will add `resolvedBy` audit field + unknown-cluster warning on top of this.
 */

import { execSync } from 'child_process';
import type { StoryStore } from './store.js';
import type { Finding } from './types.js';
import type { ClusterRecord } from './cluster-types.js';

export interface CommitMeta {
  /** Full commit sha (40 char) */
  sha: string;
  /** commit message (full body) */
  message: string;
}

export interface ClusterSyncResult {
  /** Number of findings newly marked as resolved in this scan */
  resolved: number;
  /** Non-fatal warnings (e.g., Resolves: CL-xxx references unknown cluster) */
  warnings: string[];
  /** Map of matched commit → clusterId (in scan order) */
  matchedCommits: Array<{ sha: string; clusterId: string }>;
}

/**
 * Regex template: Resolves: CL-001 / Resolve: CL-002 / resolves: CL-003 (case + singular/plural insensitive).
 *
 * F-010: Each applyCommitResolves invocation creates a new RegExp instance inside the function body,
 * avoiding lastIndex pollution on module-level /g flag regex under concurrent/reentrant scenarios.
 * F-030: CL-\d{3,} allows 3 or more digits (padStart(3) guarantees minimum width, CL-1000+ 4 digits matches naturally).
 */
const RESOLVES_LINE_RE_SOURCE = '^\\s*Resolves?:\\s+(.+)$';
const RESOLVES_TOKEN_RE_SOURCE = '(?:[A-Za-z0-9_-]+:)?F-\\d{3,}|CL-\\d{3,}';

function findingDisplayRef(finding: Finding, rawRef: string): string {
  return rawRef.includes(':') ? finding.id : finding.id.split(':').pop() || finding.id;
}

/**
 * Pure sub-function: given findings / clusters / commitMessages, returns the result after applying Resolves.
 *
 * Side effects are limited to the passed-in findings array (in-place status mutation) — caller is responsible for persistence.
 * Does not read git, does not read files; easy to feed commit message string arrays directly for fixture testing.
 */
export function applyCommitResolves(
  findings: Finding[],
  clusters: ClusterRecord[],
  commitMessages: CommitMeta[],
): ClusterSyncResult {
  const clusterById = new Map<string, ClusterRecord>();
  for (const c of clusters) clusterById.set(c.clusterId.toUpperCase(), c);

  const findingById = new Map<string, Finding>();
  for (const f of findings) {
    findingById.set(f.id.toUpperCase(), f);
    const short = f.id.split(':').pop();
    if (short) findingById.set(short.toUpperCase(), f);
  }

  const matchedCommits: Array<{ sha: string; clusterId: string }> = [];
  const warnings: string[] = [];
  let resolved = 0;

  // F-010: function-local RegExp, each call has independent lastIndex, thread/reentry safe.
  const lineRe = new RegExp(RESOLVES_LINE_RE_SOURCE, 'gim');
  const tokenRe = new RegExp(RESOLVES_TOKEN_RE_SOURCE, 'gi');
  for (const { sha, message } of commitMessages) {
    lineRe.lastIndex = 0;
    let lineMatch: RegExpExecArray | null;
    const seenInThisCommit = new Set<string>();
    while ((lineMatch = lineRe.exec(message)) !== null) {
      tokenRe.lastIndex = 0;
      const refsText = lineMatch[1];
      let tokenMatch: RegExpExecArray | null;
      while ((tokenMatch = tokenRe.exec(refsText)) !== null) {
        const rawRef = tokenMatch[0];
        const ref = rawRef.toUpperCase();
        if (seenInThisCommit.has(ref)) continue; // duplicate tags within the same commit count only once
        seenInThisCommit.add(ref);

        const shortSha = sha.slice(0, 7);
        if (ref.startsWith('CL-')) {
          const cluster = clusterById.get(ref);
          if (!cluster) {
            warnings.push(`Resolves: ${ref} references unknown cluster (commit ${shortSha})`);
            continue;
          }

          matchedCommits.push({ sha, clusterId: ref });
          for (const fid of cluster.findingIds) {
            const f = findingById.get(fid.toUpperCase());
            if (!f) continue;
            if (f.status !== 'open') continue; // idempotent: skip already resolved/dismissed, do not overwrite resolvedBy
            f.status = 'resolved';
            // CHK-010: audit field — record which cluster's which commit triggered the resolve
            f.resolvedBy = `${ref}@${shortSha}`;
            resolved += 1;
          }
          continue;
        }

        const finding = findingById.get(ref);
        if (!finding) {
          warnings.push(`Resolves: ${rawRef} references unknown finding (commit ${shortSha})`);
          continue;
        }
        matchedCommits.push({ sha, clusterId: findingDisplayRef(finding, rawRef) });
        if (finding.status !== 'open') continue;
        finding.status = 'resolved';
        finding.resolvedBy = `${findingDisplayRef(finding, rawRef)}@${shortSha}`;
        resolved += 1;
      }
    }
  }

  return { resolved, warnings, matchedCommits };
}

/**
 * Parse commit list from `git log --format=%H%x00%B main..HEAD`.
 *
 * Git unavailable (non-git directory / no main branch / no commits) → return { commits: [], error? }.
 * F-023: errors like `fatal: bad revision 'main..HEAD'` / `unknown revision` are not silently swallowed,
 * but exposed to syncClusterResolves via return value, and the outer shell converts them into warnings output via ctx.log.
 */
export function readCommitsSinceMain(projectRoot: string): { commits: CommitMeta[]; error?: string } {
  let raw: string;
  try {
    raw = execSync('git log --format=%H%x00%B%x1e main..HEAD', {
      cwd: projectRoot,
      encoding: 'utf-8',
      // capture stderr so callers can surface fatal: bad revision / unknown revision
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) {
    const stderr = String((e as { stderr?: Buffer | string }).stderr ?? '').trim();
    const msg = stderr || String((e as Error).message || '').trim() || 'git log failed';
    return { commits: [], error: msg };
  }
  if (!raw || !raw.trim()) return { commits: [] };

  // each commit structure: <sha>\x00<body>\x1e
  const commits: CommitMeta[] = [];
  for (const entry of raw.split('\x1e')) {
    const chunk = entry.trim();
    if (!chunk) continue;
    const nullIdx = chunk.indexOf('\x00');
    if (nullIdx < 0) continue;
    const sha = chunk.slice(0, nullIdx).trim();
    const message = chunk.slice(nullIdx + 1);
    if (sha) commits.push({ sha, message });
  }
  return { commits };
}

/**
 * Sync entry: scan the story's commits + clusters, mark open findings within clusters hit by Resolves: CL-xxx as resolved.
 *
 * Callers:
 *   - `finding_list` handler (scan once before each list to stay timely)
 *   - `validate` handler (scan before running validate, so TEST gate counts correctly)
 *
 * Idempotency guard: already resolved ones are not re-marked. Git unavailable → return warning (do not throw).
 *
 * F-007: the caller passes a `log` callback, syncClusterResolves directly ctx.logs each warning into validate's
 * main output log stream (rather than console.warn to stderr which gets swallowed by validate).
 */
export function syncClusterResolves(
  storyId: string,
  store: StoryStore,
  projectRoot: string,
  log?: (msg: string) => void,
): ClusterSyncResult {
  const clustersData = store.readClusters(storyId);
  const { commits, error } = readCommitsSinceMain(projectRoot);
  if (error) {
    // F-023: git fatal (bad revision / main branch missing / non-git directory) converted to warning exposed to user.
    const short = summarizeGitError(error);
    const w = `cluster-sync skipped: ${short}`;
    log?.(w);
    return { resolved: 0, warnings: [w], matchedCommits: [] };
  }
  if (commits.length === 0) {
    return { resolved: 0, warnings: [], matchedCommits: [] };
  }
  const findingsData = store.readFindings(storyId);
  const result = applyCommitResolves(findingsData.findings, clustersData.clusters, commits);
  if (result.resolved > 0) {
    store.writeFindings(storyId, findingsData);
  }
  // F-007: each warning is actively routed via the log callback into validate's main output
  if (log) {
    for (const w of result.warnings) log(w);
  }
  return result;
}

/**
 * Condense git stderr into a human-readable one-line warning summary.
 * F-023: compress `fatal: ambiguous argument 'main..HEAD': unknown revision ...` into
 * Short hints like `main branch not found`, avoiding mixing long stderr into the warning.
 */
function summarizeGitError(err: string): string {
  const lower = err.toLowerCase();
  if (lower.includes('unknown revision') || lower.includes('bad revision') || lower.includes('ambiguous argument')) {
    return 'main branch not found (unknown revision main)';
  }
  if (lower.includes('not a git repository')) {
    return 'not a git repository';
  }
  // For other cases, take the first line and truncate to 120 characters
  const firstLine = err.split('\n')[0].trim();
  return firstLine.length > 120 ? firstLine.slice(0, 117) + '...' : firstLine;
}
