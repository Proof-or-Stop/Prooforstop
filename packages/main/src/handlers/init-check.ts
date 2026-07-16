/**
 * Init Check handler — lattice init_check_set command shell + metadata lock.
 *
 * The signature/gate primitives (INIT_CHECK_SALT, REQUIRED_INIT_CHECK_AGENTS,
 * normalize/match/results helpers, missingRequiredInitCheckAgents,
 * blockingInitCheckIssues, computeBackgroundHash, computeChecklistHash,
 * signInitCheck, recomputeInitCheckHash) live in core/init-check-gate.ts so that
 * core consumers (machine.ts) can verify the hash and evaluate the INIT_CHECK
 * gate without an upward core→handlers import (B-37e9 F-001 layering fix). This
 * file imports them and re-exports them for backward-compatible callers while
 * keeping the init_check_set handler factory and the metadata-write lock here.
 *
 * For the signature structure and gate semantics of init-check.json (the artifact of the INIT → INIT_CHECK hard gate), see
 * the module comment in core/init-check-gate.ts.
 */

import { execSync } from 'child_process';
import { StoryStore } from '../core/store.js';
import type { HandlerContext } from './context.js';
import type { InitCheckData, InitCheckIssue } from '../core/types.js';
import { autoCommitStoryMetadata } from '../core/auto-commit-metadata.js';
import { currentMaterialHash } from '../core/evidence-freshness.js';
import { resolveGitCwd } from '../core/story-signed-workspace-resolution.js';
import { getSessionId } from '../core/story-owner-lease.js';
import { assertRegisteredAgentMutationAllowed } from '../core/agent-dispatch-registry.js';
import {
  INIT_CHECK_SALT,
  REQUIRED_INIT_CHECK_AGENTS,
  INIT_CHECK_FALLBACK_AGENT_SUFFIX,
  normalizeAgentId,
  initCheckAgentMatches,
  initCheckAgentResults,
  initCheckAttestationMode,
  missingRequiredInitCheckAgents,
  blockingInitCheckIssues,
  computeBackgroundHash,
  computeChecklistHash,
  signInitCheck,
  recomputeInitCheckHash,
} from '../core/init-check-gate.js';
import { withMkdirLock } from '../core/mkdir-lock.js';

// Backward-compatible re-exports: existing importers (core/machine.ts now reads
// from core directly; story-create.ts / draft-check.ts still import from here).
export {
  INIT_CHECK_SALT,
  REQUIRED_INIT_CHECK_AGENTS,
  INIT_CHECK_FALLBACK_AGENT_SUFFIX,
  normalizeAgentId,
  initCheckAgentMatches,
  initCheckAgentResults,
  initCheckAttestationMode,
  missingRequiredInitCheckAgents,
  blockingInitCheckIssues,
  computeBackgroundHash,
  computeChecklistHash,
  signInitCheck,
  recomputeInitCheckHash,
};

/** B-95d8 CHK-001: minimum length for a manual fallback attestation reason. */
export const INIT_CHECK_FALLBACK_REASON_MIN = 30;

function withInitCheckLock<T>(store: StoryStore, storyId: string, fn: () => T): T {
  const lockDir = store.storyFilePath(storyId, 'init-check.lock');
  return withMkdirLock(lockDir, fn, { label: 'init-check metadata' });
}

/**
 * init_check_set handler factory.
 *
 * Called by the lattice-review-story-init subagent (CHK-002 template); writes init-check.json.
 * Does not validate the caller's agentId (EXP-001 has falsified the mechanical distinguishability between subagent and main agent from the CLI perspective);
 * agentId is passed through purely as a reviewer-self-reported audit field. Anti-self-exemption relies on three layers: (1) the signature mechanism +
 * (2) the reviewer template fence + (3) CLAUDE.md behavioral conventions (same architecture as the landed B-ed3e scope-check).
 *
 * Three-layer validation (CLAUDE.md "Handler coding conventions"):
 * - Zod schema: the cli-engine.ts registration side defines the issues array structure + severity enum + desc min(1)
 * - runtime (this handler's entry): re-validates desc.trim().length >= 1 to prevent paths that bypass Zod
 * - gate decision point (CHK-005 implementation): when consuming init-check.json.issues, applies trim validation by the same standard
 */
export function createInitCheckHandlers(ctx: HandlerContext): Record<string, (...args: any[]) => any> {
  const { store, root } = ctx;
  return {
    init_check_set(args: {
      storyId: string;
      issues: InitCheckIssue[];
      agent?: string;
      agentId?: string;
    }): string {
      assertRegisteredAgentMutationAllowed(args.agent || process.env.LATTICE_AGENT || args.agentId, 'init_check_set');
      return withInitCheckLock(store, args.storyId, () => {
      // 1) story existence check (same approach as scope_check_save)
      let title = '';
      let description = '';
      let reviewRound = '';
      try {
        const story = store.readStory(args.storyId);
        title = story.title;
        description = story.description;
        reviewRound = story.currentReviewRound || '';
      } catch {
        throw new Error(`Story ${args.storyId} not found`);
      }

      // 2) runtime validation of issues (guards against Zod-bypass paths, aligned with the gate-side trim standard)
      const issues = Array.isArray(args.issues) ? args.issues : [];
      for (const issue of issues) {
        if (!issue || typeof issue.desc !== 'string' || issue.desc.trim().length < 1) {
          throw new Error(
            `init_check_set: each issue.desc must be >= 1 character after trim (reviewer subjective judgments need to be concrete)`,
          );
        }
      }

      // 3) compute the three hashes required for the signature
      const backgroundHash = computeBackgroundHash(root, args.storyId);
      let items: Array<{ title: string; context?: string }> = [];
      try {
        const checklist = store.readChecklist(args.storyId);
        items = checklist.items.map(i => ({ title: i.title, context: i.context }));
      } catch {
        // when checklist.json does not exist, hash is computed against an empty array (consistent with recomputeInitCheckHash behavior)
      }
      const checklistHash = computeChecklistHash(items);

      // 4) invoke the signing function (shares signInitCheck with recomputeInitCheckHash — single source of truth)
      const _hash = signInitCheck(args.storyId, backgroundHash, title, description, checklistHash, reviewRound);

      // 5) construct InitCheckData and persist to disk
      const checkedAt = new Date().toISOString();
      const agentId = normalizeAgentId(args.agentId || args.agent);
      const previous = store.readInitCheck(args.storyId);
      const agentResults = previous ? initCheckAgentResults(previous).filter(
        result => !initCheckAgentMatches(result.agentId, agentId) && result.agentId !== agentId,
      ) : [];
      agentResults.push({ agentId, checkedAt, issues });

      const data: InitCheckData = {
        storyId: args.storyId,
        checkedAt,
        reviewRound,
        agentId,
        issues,
        agentResults,
        _hash,
      };
      store.writeInitCheck(args.storyId, data);

      // 6) return value contains issue counts bucketed by severity (advisory mode: critical does not block here either,
      //    the reviewer template self-disciplines and refuses the call; the CHK-005 gate-side advance success message will then echo a critical warning)
      let critical = 0, high = 0, medium = 0, low = 0;
      for (const issue of issues) {
        switch (issue.severity) {
          case 'critical': critical++; break;
          case 'high': high++; break;
          case 'medium': medium++; break;
          case 'low': low++; break;
        }
      }
      const missing = missingRequiredInitCheckAgents(data);
      const commitHint = autoCommitStoryMetadata(root, args.storyId, 'init_check_set');
      return `Init check saved for ${args.storyId}: ${issues.length} issues (${critical}/${high}/${medium}/${low}); recorded agents: ${agentResults.map(r => r.agentId || '<unknown>').join(', ')}${missing.length > 0 ? `; missing required agents: ${missing.join(', ')}` : ''}${commitHint}`;
      });
    },

    /**
     * init_check_repair — B-95d8 CHK-001 explicit, auditable INIT_CHECK fallback.
     *
     * For environments that cannot spawn the lattice-review-story-init / product-reviewer
     * subagents (no init reviewer available). Produces a SIGNED init-check.json that
     * `canEnterInitCheck` / `getGuardFailureReason` accept — WITHOUT weakening the gate:
     *
     *  - The signature is computed by the SAME `signInitCheck` over the SAME domain
     *    (background/title/description/checklist). Editing any signed story content
     *    afterwards still triggers `init_check_tampered` (the recompute diverges).
     *  - Required-reviewer coverage is satisfied by recording each required agent as
     *    `<required>@fallback`; `initCheckAgentMatches` accepts the `<required>@`
     *    prefix, so missingRequiredInitCheckAgents is empty, while the `@fallback`
     *    suffix + `fallback` block keep the manual attestation mechanically
     *    distinguishable from an independent reviewer run (initCheckAttestationMode).
     *  - Operator-supplied issues still flow through blockingInitCheckIssues: attesting
     *    a high/critical issue self-blocks (you cannot fallback past a real blocker).
     *
     * NOT default-on: rejects (no file written, no phase change) unless BOTH an
     * explicit `acknowledge: true` AND a `fallbackReason` (>= 30 chars) are supplied.
     * Does NOT check agentId mechanically (EXP-001: caller identity is not mechanically
     * distinguishable in the Bash CLI).
     */
    init_check_repair(args: {
      storyId: string;
      fallbackReason: string;
      acknowledge?: boolean;
      mode?: 'repair' | 'fallback';
      evidenceRefs?: string[];
      issues?: InitCheckIssue[];
      actor?: string;
    }): string {
      // --- Controlled-opt-in preflight (runtime, NOT Zod-only; CLAUDE.md Handler convention) ---
      // These guards MUST run before any read/write so a refusal produces ZERO file
      // write and ZERO phase change. Default-disabled = both ack + reason required.
      if (args.acknowledge !== true) {
        throw new Error(
          'init_check_repair: refused — this fallback bypasses the independent INIT reviewer and is disabled by default. ' +
          'Re-run with explicit acknowledgement: pass acknowledge=true to confirm you are deliberately attesting in lieu of lattice-review-story-init / product-reviewer.',
        );
      }
      const reason = (args.fallbackReason ?? '').trim();
      if (reason.length < INIT_CHECK_FALLBACK_REASON_MIN) {
        throw new Error(
          `init_check_repair: refused — fallbackReason must be >= ${INIT_CHECK_FALLBACK_REASON_MIN} characters (got ${reason.length}). ` +
          'State why the init reviewer cannot run and what you checked in its place; this is recorded as durable audit attestation.',
        );
      }
      const mode = args.mode ?? 'repair';
      if (mode !== 'repair' && mode !== 'fallback') {
        throw new Error(`init_check_repair: mode must be 'repair' or 'fallback' (got ${JSON.stringify(args.mode)})`);
      }
      const evidenceRefs = Array.isArray(args.evidenceRefs)
        ? args.evidenceRefs.map(r => String(r).trim()).filter(r => r.length > 0)
        : [];
      // issues runtime validation mirrors init_check_set (defend the bypass path).
      const issues = Array.isArray(args.issues) ? args.issues : [];
      for (const issue of issues) {
        if (!issue || typeof issue.desc !== 'string' || issue.desc.trim().length < 1) {
          throw new Error('init_check_repair: each issue.desc must be ≥ 1 character after trim');
        }
      }

      return withInitCheckLock(store, args.storyId, () => {
        // 1) story existence (preflight already passed; refusal above wrote nothing).
        let title = '';
        let description = '';
        let reviewRound = '';
        try {
          const story = store.readStory(args.storyId);
          title = story.title;
          description = story.description;
          reviewRound = story.currentReviewRound || '';
        } catch {
          throw new Error(`Story ${args.storyId} not found`);
        }

        // 2) Sign over the SAME domain as init_check_set (single source of truth).
        const backgroundHash = computeBackgroundHash(root, args.storyId);
        let items: Array<{ title: string; context?: string }> = [];
        try {
          const checklist = store.readChecklist(args.storyId);
          items = checklist.items.map(i => ({ title: i.title, context: i.context }));
        } catch {
          // checklist absent → empty array hash (matches recomputeInitCheckHash).
        }
        const checklistHash = computeChecklistHash(items);
        const _hash = signInitCheck(args.storyId, backgroundHash, title, description, checklistHash, reviewRound);

        // 3) Required-reviewer coverage via `<required>@fallback` records. The bare
        //    operator-supplied issues land on the story-init record (so they flow
        //    through blockingInitCheckIssues); the product-reviewer record is clean.
        const checkedAt = new Date().toISOString();
        const agentResults = REQUIRED_INIT_CHECK_AGENTS.map((required, idx) => ({
          agentId: `${required}@${INIT_CHECK_FALLBACK_AGENT_SUFFIX}`,
          checkedAt,
          issues: idx === 0 ? issues : [],
        }));

        // 4) Audit attestation block (NOT in signature domain; surface + traceability).
        // B-75f0 CHK-002: a real storyId (args.storyId) + store are in scope, so
        // resolve the audit git cwd with the id-keyed resolveGitCwd. On a
        // wrapper-root layout it is the real gitRoot subdir so the headHash /
        // git-identity probes read the actual repo; on a plain repo (or when no
        // gitRoot resolves) it falls back to root verbatim (byte-identical). The
        // omit-on-failure behavior (try/catch leaving headHash/actor unset) is
        // preserved on a non-git or unavailable cwd.
        const auditGitCwd = resolveGitCwd({ store, storyId: args.storyId, metadataRoot: root, projectRoot: root });
        let headHash: string | undefined;
        try {
          headHash = execSync('git rev-parse HEAD', { cwd: auditGitCwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim() || undefined;
        } catch { /* PROBE: non-git or unavailable, omit headHash */ }
        const materialHash = currentMaterialHash(root) || undefined;
        let actor = (args.actor ?? '').trim();
        if (!actor) {
          try {
            actor = execSync('git config user.name', { cwd: auditGitCwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
          } catch { /* PROBE: no git identity, leave actor empty */ }
        }
        let session: string | undefined;
        try {
          session = getSessionId() || undefined;
        } catch { /* PROBE: session id unavailable */ }

        const data: InitCheckData = {
          storyId: args.storyId,
          checkedAt,
          reviewRound,
          agentId: `${REQUIRED_INIT_CHECK_AGENTS[0]}@${INIT_CHECK_FALLBACK_AGENT_SUFFIX}`,
          issues,
          agentResults,
          fallback: {
            mode,
            reason,
            ...(evidenceRefs.length > 0 ? { evidenceRefs } : {}),
            ...(actor ? { actor } : {}),
            ...(session ? { session } : {}),
            attestedAt: checkedAt,
            ...(headHash ? { headHash } : {}),
            ...(materialHash ? { materialHash } : {}),
          },
          _hash,
        };
        store.writeInitCheck(args.storyId, data);

        // 5) Durable audit event in the process timeline (advisory; init-check.json
        //    is the signed truth, this is the activity-log projection).
        try {
          store.appendProcessEvent(args.storyId, {
            type: 'init_check_fallback',
            mode,
            ...(actor ? { actor } : {}),
            ...(session ? { session } : {}),
            ...(headHash ? { headHash } : {}),
          });
        } catch (e) {
          console.warn(`[process-events] append failed for ${args.storyId}:`, (e as Error).message);
        }

        const blockers = blockingInitCheckIssues(data);
        const commitHint = autoCommitStoryMetadata(root, args.storyId, 'init_check_repair');
        const auditLine = `⚠ fallback has been recorded in audit events (actor=${actor || '<unknown>'}, mode=${mode}${session ? `, session=${session}` : ''}), signature verification was not bypassed`;
        const boundaryLine = `⚠ Fallback only repairs INIT_CHECK; it does not authorize implementation and does not replace later PLAN/DEV/REVIEW/TEST reviewers.`;
        if (blockers.length > 0) {
          // Operator attested blocking issues → gate still blocks. Be explicit.
          const lines = blockers.slice(0, 8).map(({ issue }) => `  - ${issue.severity} ${issue.id ? `${issue.id} ` : ''}${issue.desc}`);
          return `✓ init-check.json generated (fallback channel, signature domain unchanged)\n${auditLine}\n${boundaryLine}\n⚠ but high/critical issues were recorded, the INIT_CHECK gate will still block. Please fix them and rerun first:\n${lines.join('\n')}${commitHint}`;
        }
        return `✓ init-check.json generated (fallback channel, signature domain unchanged)\n${auditLine}\n${boundaryLine}\n→ You can now run lattice story_advance --storyId=${args.storyId} --phase=INIT_CHECK${commitHint}`;
      });
    },
  };
}
