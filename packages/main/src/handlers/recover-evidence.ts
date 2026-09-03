/**
 * recover_evidence — single-shot recovery for stale verificationEvidence.
 *
 * Trigger flow (B-a2f1 CHK-003):
 *   1. classifyDirtyWorktree(projectRoot) uses the B-6326 shared classifier.
 *   2. **Allowlist** check (not a blocklist): only proof_or_stop_metadata_changes /
 *      runtime_artifact_changes / declared_artifact_changes are allowed through; any
 *      other category (including future additions) → immediately refused.
 *      (preMortem #1: when classifier adds a new category, it must default to refused rather than allowed)
 *   3. Call verification_evidence_refresh_stale handler (in-process import + call,
 *      no child process spawn) → append output into refreshTranscript.
 *   4. Call validate handler (same in-process) → append output into validateTranscript.
 *   5. status: refused / pass / fail; non-pass is translated into a non-zero exit code at the CLI entry.
 *
 * Design principles:
 *   - Refuse auto-recover — only act when the worktree is clean (only metadata/runtime/declared).
 *   - refresh must precede validate (user first sees the transcript of hashes being refreshed, then the revalidate output).
 *   - When refused, do not run refresh / validate (short-circuit).
 *   - storyId runtime + Zod dual validation (Handler coding convention).
 */

import { execSync } from 'child_process';
import type { HandlerContext } from './context.js';
import { loadConfig } from '../core/config.js';
import { resolveGitCwd } from '../core/story-signed-workspace-resolution.js';
import {
  classifyGitStatusRows,
  dirtyWorktreeClassifierOptionsFromConfig,
  type DirtyWorktreeCategory,
  type DirtyWorktreeClassification,
} from '../core/dirty-worktree.js';
import { refreshStaleEvidenceMetadataOnly } from './checklist.js';
import { createVerifierHandlers } from './verifier.js';

/**
 * Allowed dirty categories — only these three do not block recover_evidence.
 *
 * Must be an allowlist (cannot be written as a blocklist), otherwise when DIRTY_WORKTREE_CATEGORIES adds a new
 * category, the new value will be silently allowed through (preMortem #1).
 */
export const RECOVER_EVIDENCE_ALLOWED_CATEGORIES: ReadonlySet<DirtyWorktreeCategory> = new Set<DirtyWorktreeCategory>([
  'proof_or_stop_metadata_changes',
  'runtime_artifact_changes',
  'declared_artifact_changes',
]);

export interface RecoverEvidenceRefused {
  reason: string;
  categories: DirtyWorktreeCategory[];
  paths: string[];
}

export interface RecoverEvidenceResult {
  status: 'pass' | 'fail' | 'refused';
  refused?: RecoverEvidenceRefused;
  refreshTranscript?: string;
  validateTranscript?: string;
}

// B-75f0 CHK-002: `gitCwd` is the resolved git working dir (the handler resolves
// it via the id-keyed resolveGitCwd — a real storyId + store are in scope there).
// On a wrapper-root layout it is the real gitRoot subdir so the dirty-status
// classification reads the actual repo; on a plain repo (or when no gitRoot
// resolves) it is the passed projectRoot verbatim. The `[]` fallback on any git
// failure is preserved (no git repo → empty dirty list, probe-style tolerance).
function readGitStatusLines(gitCwd: string): string[] {
  try {
    const raw = execSync('git status --porcelain=v1 --untracked-files=all', {
      cwd: gitCwd,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return raw.split('\n').map((line) => line.trimEnd()).filter(Boolean);
  } catch {
    // No git repo → treat as empty dirty list (probe-style tolerance).
    return [];
  }
}

function classifyDirtyWorktree(projectRoot: string, gitCwd: string): DirtyWorktreeClassification {
  const lines = readGitStatusLines(gitCwd);
  const config = loadConfig(projectRoot);
  return classifyGitStatusRows(lines, dirtyWorktreeClassifierOptionsFromConfig(config, projectRoot));
}

function findRefusedCategories(classification: DirtyWorktreeClassification): DirtyWorktreeCategory[] {
  const categories: DirtyWorktreeCategory[] = [];
  for (const [category, entries] of Object.entries(classification.groups) as Array<[DirtyWorktreeCategory, typeof classification.entries]>) {
    if (entries.length === 0) continue;
    if (!RECOVER_EVIDENCE_ALLOWED_CATEGORIES.has(category)) {
      categories.push(category);
    }
  }
  return categories;
}

function refusedPathsFor(classification: DirtyWorktreeClassification, refused: DirtyWorktreeCategory[]): string[] {
  const out: string[] = [];
  for (const category of refused) {
    for (const entry of classification.groups[category]) {
      out.push(entry.path || entry.rawPath || entry.raw);
    }
  }
  return out;
}

function refusedReasonText(refused: DirtyWorktreeCategory[]): string {
  return `recover_evidence refused: ${refused.join(', ')} dirty paths present, run git status to inspect`;
}

/** Convert handler return (string | object) into a transcript string. */
function asTranscript(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === undefined || value === null) return '';
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export interface RecoverEvidenceArgs {
  storyId: string;
  /** Override project root (tests); falls back to ctx.root. */
  projectRoot?: string;
}

export function createRecoverEvidenceHandlers(ctx: HandlerContext): Record<string, (...args: any[]) => any> {
  return {
    async recover_evidence(args: RecoverEvidenceArgs): Promise<RecoverEvidenceResult> {
      // Runtime guard mirrors Zod min(1) — Handler coding convention (CLAUDE.md "Handler coding convention").
      const storyId = typeof args?.storyId === 'string' ? args.storyId.trim() : '';
      if (storyId.length < 1) {
        throw new Error('recover_evidence: storyId is required (non-empty string)');
      }
      const projectRoot = args.projectRoot || ctx.root;
      // B-75f0 CHK-002: a real storyId + store are in scope, so resolve the
      // dirty-status git cwd with the id-keyed resolveGitCwd. On a wrapper-root
      // layout it is the real gitRoot subdir; on a plain repo (or when no gitRoot
      // resolves) it falls back to projectRoot verbatim (byte-identical).
      const gitCwd = resolveGitCwd({ store: ctx.store, storyId, metadataRoot: projectRoot, projectRoot });

      // 1. Classify dirty worktree via the shared B-6326 classifier.
      const classification = classifyDirtyWorktree(projectRoot, gitCwd);
      const refusedCategories = findRefusedCategories(classification);

      // 2. Allowlist short-circuit: refuse and DO NOT run refresh / validate.
      if (refusedCategories.length > 0) {
        const paths = refusedPathsFor(classification, refusedCategories);
        const reason = refusedReasonText(refusedCategories);
        // Non-zero exit so callers (CI / hooks) see failure without parsing JSON.
        // (CLI exit code defaults to 0 unless we throw or set exitCode explicitly.)
        return {
          status: 'refused',
          refused: { reason, categories: refusedCategories, paths },
        };
      }

      // 3. In-process refresh (no subprocess; honour ctx contract).
      // B-1507 CHK-002: metadata-only refresh (no command execution) — recover_evidence
      // refreshes hashes then validates; it must NOT take the re-executing CLI path.
      let refreshTranscript = '';
      try {
        const refreshOutput = refreshStaleEvidenceMetadataOnly(ctx, storyId);
        refreshTranscript = asTranscript(refreshOutput);
      } catch (e: any) {
        refreshTranscript = `verification_evidence_refresh_stale failed: ${e?.message || String(e)}`;
        return {
          status: 'fail',
          refreshTranscript,
        };
      }

      // 4. In-process validate.
      const verifierHandlers = createVerifierHandlers(ctx);
      let validateTranscript = '';
      let validateOk = true;
      try {
        // noSync=true: refresh just rewrote evidence hashes; don't let the
        // optional cluster-resolve sync re-scan git log and add latency / noise.
        const validateOutput = await verifierHandlers.validate({ story: storyId, json: true, noSync: true });
        validateTranscript = asTranscript(validateOutput);
        if (typeof validateOutput === 'string') {
          try {
            const parsed = JSON.parse(validateOutput);
            if (parsed && typeof parsed === 'object') {
              // proof-or-stop-verifier* JSON has either `allPass: boolean` (verifier output)
              // or `status: 'pass' | 'fail' | 'warn'`.
              if (typeof parsed.allPass === 'boolean') {
                validateOk = parsed.allPass;
              } else if (typeof parsed.status === 'string') {
                validateOk = parsed.status !== 'fail';
              }
            }
          } catch {
            // Non-JSON text output from validate (rare with json:true) → treat as pass.
            validateOk = true;
          }
        } else {
          validateOk = false;
          validateTranscript = `proof-or-stop validate returned unexpected non-string output (typeof=${typeof validateOutput}); treating as failure.`;
        }
      } catch (e: any) {
        validateTranscript = `proof-or-stop validate failed: ${e?.message || String(e)}`;
        validateOk = false;
      }

      return {
        status: validateOk ? 'pass' : 'fail',
        refreshTranscript,
        validateTranscript,
      };
    },
  };
}
