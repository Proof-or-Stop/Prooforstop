/**
 * B-3fad CHK-002: gap_log — manual archival entry for framework gaps.
 *
 * Trigger background (background.md): When wrapping up B-a370, the main agent wanted to archive discovered koala framework gaps into
 * the framework-audit backlog, but found (1) the B-META-framework-audit container did not exist, (2) the existing
 * finding_add is reviewer-finding shaped (requires reviewRunId / REVIEW-phase semantics), using it to stuff
 * manual framework gaps is abuse. gap_log fills this hole: a manual archival entry that does not depend on reviewer / review round /
 * story worktree.
 *
 * Design points:
 * - Required category / severity / evidence note(desc) / source (one of sourceRefs etc.): none can be omitted,
 *   to prevent B-META from becoming a garbage bin (understanding.constraints).
 * - Default evidenceState=suspected: manual backfill has not been mechanically confirmed, can only be suspected (inherits bug channel evidence discipline).
 * - verified guardrail: only when structured evidence fields (sourceRefs / reproCommand /
 *   observedOutput / analysisNote one or more) are provided simultaneously is verified allowed; otherwise even if verified is passed it is forced
 *   downgraded back to suspected (cannot directly fabricate a confirmed conclusion).
 * - Written to the B-META-framework-audit container (if not present then ensureMetaStory bootstrap), reusing
 *   the audit-meta-store findings.json storage path, not building parallel storage.
 * - Does not require a story worktree, does not participate in lifecycle gates (writes to a long-lived container, not an active story).
 *
 * Three-layer validation (CLAUDE.md "Handler coding conventions"):
 * - Zod schema (cli-engine.ts): category enum / severity enum / desc.min(1) first line of defense.
 * - runtime (this handler entry): re-validates desc trim non-empty, source at least one, verified guardrail,
 *   to prevent internal fn / legacy JSON call paths that bypass Zod.
 * - Consumption point (audit-meta-store.appendGapFinding): trust the validated inputs as-is.
 */

import type { HandlerContext } from './context.js';
import type { Finding, FindingEvidenceState } from '../core/types.js';
import { ensureMetaStory, appendGapFinding, META_STORY_ID } from '../core/audit-meta-store.js';
import { withReentrantMainWriteLock } from '../core/main-write-lock.js';
import { resolveMainRepoRoot } from '../core/partial-done-recovery.js';

const GAP_LOG_CATEGORIES = ['happy', 'edge', 'adversarial', 'missing'] as const;
const GAP_LOG_SEVERITIES = ['critical', 'high', 'medium', 'low'] as const;

/** runtime narrow: reject invalid category (not just relying on Zod). */
function isGapLogCategory(value: unknown): value is Finding['category'] {
  return typeof value === 'string' && (GAP_LOG_CATEGORIES as readonly string[]).includes(value);
}

/** runtime narrow: reject invalid severity (not just relying on Zod). */
function isGapLogSeverity(value: unknown): value is Finding['severity'] {
  return typeof value === 'string' && (GAP_LOG_SEVERITIES as readonly string[]).includes(value);
}

/**
 * Normalize the structured evidence fields in the inputs.
 * If any element exists in the returned non-empty array, it is considered "structured evidence provided" (the basis for the verified guard).
 */
function collectStructuredEvidence(args: {
  sourceRefs?: string[];
  reproCommand?: string;
  observedOutput?: string;
  analysisNote?: string;
}): {
  sourceRefs: string[];
  reproCommand?: string;
  observedOutput?: string;
  analysisNote?: string;
  hasAny: boolean;
} {
  const sourceRefs = Array.isArray(args.sourceRefs)
    ? args.sourceRefs.map(r => String(r ?? '').trim()).filter(r => r.length > 0)
    : [];
  const reproCommand = (args.reproCommand ?? '').trim() || undefined;
  const observedOutput = (args.observedOutput ?? '').trim() || undefined;
  const analysisNote = (args.analysisNote ?? '').trim() || undefined;
  const hasAny = sourceRefs.length > 0 || !!reproCommand || !!observedOutput || !!analysisNote;
  return { sourceRefs, reproCommand, observedOutput, analysisNote, hasAny };
}

export function createGapLogHandlers(ctx: HandlerContext): Record<string, (...args: any[]) => any> {
  const { store } = ctx;
  return {
    /**
     * gap_log: archive a manually discovered framework gap into B-META-framework-audit.
     *
     * Required: category / severity / evidence (gap description, i.e., desc) / source (one of sourceRefs etc.).
     * Default evidenceState=suspected; verified requires matching structured evidence.
     */
    gap_log(args: {
      category?: string;
      severity?: string;
      /** evidence note of the gap -- i.e., the finding description */
      evidence?: string;
      sourceRefs?: string[];
      reproCommand?: string;
      observedOutput?: string;
      analysisNote?: string;
      evidenceState?: string;
      uncertaintyReason?: string;
      files?: string[];
      agent?: string;
    } = {}): string {
      // 1) category required + runtime enum validation
      if (!isGapLogCategory(args.category)) {
        throw new Error(
          `gap_log: category is required and must be one of ${GAP_LOG_CATEGORIES.join('|')} (prevents B-META from becoming a dumping ground)`,
        );
      }
      // 2) severity required + runtime enum validation
      if (!isGapLogSeverity(args.severity)) {
        throw new Error(
          `gap_log: severity is required and must be one of ${GAP_LOG_SEVERITIES.join('|')}`,
        );
      }
      // Capture the runtime-narrowed values into local consts: the type guards
      // above narrow `args.category` / `args.severity` here, but TS widens a
      // captured *mutable property* back to `string` inside the closure below.
      const category: Finding['category'] = args.category;
      const severity: Finding['severity'] = args.severity;
      // 3) evidence note (desc) required, non-empty after trim (empty string / pure whitespace rejected)
      const desc = (args.evidence ?? '').trim();
      if (desc.length < 1) {
        throw new Error(
          'gap_log: evidence is required and must be >= 1 character after trim (describe what this framework gap is)',
        );
      }
      // 4) source required: at least one of sourceRefs / reproCommand / observedOutput / analysisNote
      const ev = collectStructuredEvidence(args);
      if (!ev.hasAny) {
        throw new Error(
          'gap_log: source is required -- at least one of sourceRefs / reproCommand / observedOutput / analysisNote ' +
          'must be provided, explaining where this gap was observed from (prevents source-less empty findings)',
        );
      }

      // 5) evidenceState parsing + verified guard.
      //    Default suspected. verified guard: only when structured evidence fields are also provided
      //    (one or more of sourceRefs / reproCommand / observedOutput / analysisNote) before verified is allowed.
      //    This guardrail is jointly enforced by two defenses so that verified-without-evidence is structurally impossible:
      //      (a) The source-required gate in step 4 above (throws immediately when ev.hasAny is false);
      //      (b) This verified branch independently checks ev.hasAny again — so even if the source gate is relaxed in the future,
      //          the guardrail remains self-consistent: any structured-evidence-less request is forcibly downgraded back to suspected.
      const rawState = (args.evidenceState ?? '').trim();
      let evidenceState: FindingEvidenceState = 'suspected';
      let downgraded = false;
      if (rawState === 'verified') {
        if (ev.hasAny) {
          evidenceState = 'verified';
        } else {
          // Defensive branch: currently unreachable because step 4's source gate intercepts first;
          // if the source gate is relaxed in the future, this still downgrades evidence-less verified requests back to suspected.
          evidenceState = 'suspected';
          downgraded = true;
        }
      } else if (rawState === 'disproven') {
        // gap_log is the entry point for "archiving newly discovered gaps"; it does not accept directly registering disproven (disproof should go through the finding flow).
        throw new Error(
          'gap_log: evidenceState only accepts suspected / verified; for disproven counter-evidence please use the finding flow',
        );
      } else if (rawState !== '' && rawState !== 'suspected') {
        throw new Error(
          `gap_log: evidenceState invalid value "${rawState}", only suspected / verified are accepted`,
        );
      }
      // rawState === '' or 'suspected' → default to suspected

      // 6) suspected requires uncertaintyReason (same rule as finding_add, to prevent treating suspected as a casual button).
      //    gap_log defaults to suspected, so provide a fallback reason here to avoid manual back-fills being blocked by the missing field.
      let uncertaintyReason: string | undefined;
      if (evidenceState === 'suspected') {
        const reason = (args.uncertaintyReason ?? '').trim();
        uncertaintyReason = reason.length >= 10
          ? reason
          : 'manually logged framework gap; not yet mechanically reproduced or confirmed';
      }

      // 7) Merge finding.files: both sourceRefs (structured evidence references) and the explicit files argument are preserved.
      //    F-003: the old implementation had two spreads writing the same `files` key, with the latter silently overriding the former → sourceRefs were lost.
      //    Changed to merged dedup, so the stored finding carries paths from both sources.
      const argFiles = Array.isArray(args.files)
        ? args.files.map(f => String(f ?? '').trim()).filter(f => f.length > 0)
        : [];
      const mergedFiles = Array.from(new Set([...ev.sourceRefs, ...argFiles]));

      // 8) ensureMetaStory bootstraps the container (creates it if missing) + writes B-META findings.
      //    B-f60c CHK-003: gap_log writes shared main / B-META state and must be serialized within the main write
      //    lock (session-ownership-and-write-leases.md Rule 5).
      //    Critical section = ensureMetaStory (bootstrap container) + appendGapFinding (dedup +
      //    append) — both write B-META, must be atomic.
      //    Use the *reentrant* variant: gap_log is not currently nested inside another lock-holding command, but if in the future
      //    some lock-holding command internally calls gap_log (e.g. audit archiving a gap it discovered itself), reentrant
      //    guarantees no self-deadlock. Same process already holds the lock → pass-through runs the critical section directly.
      //    Lock path resolves to main repo root (gap_log usually runs from project root, but resolveMainRepoRoot
      //    correctly falls back to the main repo root for worktree subdirectories as well).
      const mainRepoRoot = resolveMainRepoRoot(ctx.root);
      const { created, result } = withReentrantMainWriteLock(mainRepoRoot, () => {
        const ensured = ensureMetaStory(store);
        const appended = appendGapFinding(store, {
          category,
          severity,
          desc,
          evidenceState,
          ...(uncertaintyReason ? { uncertaintyReason } : {}),
          ...(mergedFiles.length > 0 ? { files: mergedFiles } : {}),
          ...(ev.reproCommand ? { reproCommand: ev.reproCommand } : {}),
          ...(ev.observedOutput ? { observedOutput: ev.observedOutput } : {}),
          ...(ev.analysisNote ? { analysisNote: ev.analysisNote } : {}),
          agent: args.agent || process.env.KOALA_AGENT || 'koala-gap-log',
        });
        return { created: ensured.created, result: appended };
      }, {
        // gap_log is a sub-second critical section. Concurrent callers must
        // SERIALIZE-AND-WAIT so a racing duplicate is caught by the in-lock
        // idempotency dedup (→ one canonical finding) instead of fail-fasting
        // with a contention error. Waiting still honors Rule 6 — the caller
        // never proceeds without the lock.
        label: 'gap_log',
        onContention: 'wait',
      });

      const bootstrapHint = created
        ? `\n→ ${META_STORY_ID} container does not exist, auto-bootstrapped.`
        : '';
      const downgradeHint = downgraded
        ? '\n⚠ verified requested but no structured evidence provided, forcibly downgraded back to suspected.'
        : '';
      // B-f60c CHK-003: when the gap fingerprint matched an existing OPEN
      // finding, no new finding was written — surface the dedup so the operator
      // knows the canonical finding was reused, not duplicated.
      const dedupHint = result.deduped
        ? `\n→ Same gap already exists (fingerprint hit), reusing canonical finding ${result.findingId}, not creating new.`
        : '';
      const srcParts: string[] = [];
      if (ev.sourceRefs.length > 0) srcParts.push(`sourceRefs=${ev.sourceRefs.length}`);
      if (ev.reproCommand) srcParts.push('reproCommand');
      if (ev.observedOutput) srcParts.push('observedOutput');
      if (ev.analysisNote) srcParts.push('analysisNote');
      const verb = result.deduped ? 'Gap deduped' : 'Gap logged';
      return (
        `${verb}: ${result.findingId} ` +
        `(evidenceState=${result.evidenceState}, severity=${args.severity}, category=${args.category}; ` +
        `source: ${srcParts.join(', ')})` +
        bootstrapHint + downgradeHint + dedupHint
      );
    },
  };
}
