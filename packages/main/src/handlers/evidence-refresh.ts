import type { HandlerContext } from './context.js';
import { createChecklistHandlers } from './checklist.js';
import { checkEvidenceFreshnessForGit } from '../core/evidence-freshness.js';
import { resolveGitCwd } from '../core/story-signed-workspace-resolution.js';
import { collectVerificationIntents } from '../core/verification.js';
import type {
  ChecklistData,
  VerificationEvidence,
  VerificationLane,
  VerificationPriority,
} from '../core/types.js';

interface EvidenceRefreshArgs {
  storyId: string;
  apply?: boolean;
  format?: 'text' | 'json';
  json?: boolean;
  runCommands?: boolean;
  advancePhase?: boolean;
  launchReviewers?: boolean;
  authorityDone?: boolean;
  fullAuthorityDone?: boolean;
  productionDone?: boolean;
}

/**
 * A row that ONE refresh pass could re-stamp: result=pass evidence that
 * checkEvidenceFreshnessForGit reports NOT fresh (hash drift only — logic still
 * valid). This is the SAME refresh-only predicate evidence_plan (P3) uses; we
 * call checkEvidenceFreshnessForGit identically rather than inventing a new one.
 */
interface RefreshCandidate {
  intentRef: string;
  itemId: string;
  lane: VerificationLane;
  priority: VerificationPriority;
  /** Freshness drift reason BEFORE the refresh pass. */
  driftReason?: string;
}

interface RefreshedRow extends RefreshCandidate {
  /** After ONE pass the row reclassified to fresh. */
  outcome: 'refreshed';
}

type EscalationKind = 'rerun_required' | 'hard_stale';

interface EscalatedRow extends RefreshCandidate {
  outcome: EscalationKind;
  /** Why the single pass did not make it fresh. */
  escalationReason: string;
}

export interface EvidenceRefreshReport {
  storyId: string;
  mode: {
    /** evidence_refresh NEVER runs a verification command. */
    runCommands: false;
    /**
     * true IFF a refresh pass actually executed (--apply AND ≥1 refresh-only
     * candidate). --apply with 0 candidates leaves this false: no pass ran and
     * no evidence was written.
     */
    writeEvidence: boolean;
  };
  /** The refresh-only bucket detected BEFORE any pass (dry preview + apply input). */
  candidates: RefreshCandidate[];
  /** Rows that became fresh after the single pass (--apply only). */
  refreshed: RefreshedRow[];
  /** Rows still not fresh after the single pass — reported, never re-run (--apply only). */
  escalated: EscalatedRow[];
  summary: {
    candidates: number;
    refreshed: number;
    escalated: number;
  };
  claims: {
    authorityDone: false;
    fullAuthorityDone: false;
    productionDone: false;
  };
}

function wantsJson(args: EvidenceRefreshArgs): boolean {
  return args.json === true || args.format === 'json';
}

function wantsApply(args: EvidenceRefreshArgs): boolean {
  return args.apply === true || (args.apply as unknown) === 'true';
}

/**
 * Fail closed BEFORE any store read. evidence_refresh is a refresh-only
 * orchestrator: it NEVER runs a verification command, advances the lifecycle,
 * launches reviewers, or claims Authority completion. --apply is the ONE
 * sanctioned write path (a single re-stamp pass via the existing
 * verification_evidence_refresh_stale writer) and is therefore NOT rejected
 * here — it is ownership/scope-gated by the CLI ownership gate instead.
 */
function assertBoundary(args: EvidenceRefreshArgs): void {
  const rejected: string[] = [];
  if (args.runCommands === true) rejected.push('runCommands=true');
  if (args.advancePhase === true) rejected.push('advancePhase=true');
  if (args.launchReviewers === true) rejected.push('launchReviewers=true');
  if (args.authorityDone === true) rejected.push('authorityDone=true');
  if (args.fullAuthorityDone === true) rejected.push('fullAuthorityDone=true');
  if (args.productionDone === true) rejected.push('productionDone=true');
  if (rejected.length === 0) return;
  throw new Error(
    `evidence_refresh refuses unsupported side effects: ${rejected.join(' and ')}. ` +
    'evidence_refresh never runs a verification command, advances a phase, launches reviewers, or claims Authority ' +
    'completion: no story facts were read. --apply performs AT MOST ONE re-stamp pass via the existing ' +
    'verification_evidence_refresh_stale writer (ownership/scope gated); rerun_required rows are REPORTED, not executed.',
  );
}

function readChecklist(ctx: HandlerContext, storyId: string): ChecklistData {
  try {
    return ctx.store.readChecklist(storyId);
  } catch {
    return { items: [] };
  }
}

function isWaiver(ev: VerificationEvidence): boolean {
  return ev.kind === 'waiver';
}

/**
 * Build the by-intentRef evidence lookup, mirroring evidence-plan.ts: first
 * passing evidence wins, otherwise keep the first seen so a fail is still
 * surfaced when no passing record exists.
 */
function evidenceByIntentRef(checklist: ChecklistData): Map<string, VerificationEvidence> {
  const byRef = new Map<string, VerificationEvidence>();
  for (const item of checklist.items) {
    for (const ev of item.verificationEvidence ?? []) {
      if (typeof ev.intentRef !== 'string') continue;
      const existing = byRef.get(ev.intentRef);
      if (!existing) {
        byRef.set(ev.intentRef, ev);
      } else if (existing.result !== 'pass' && ev.result === 'pass') {
        byRef.set(ev.intentRef, ev);
      }
    }
  }
  return byRef;
}

/**
 * The refresh-only predicate: result=pass evidence (not a waiver) whose git
 * freshness is NOT fresh. Returns the drift reason when refresh-only, otherwise
 * null. This is the SAME classification evidence_plan applies — we call
 * checkEvidenceFreshnessForGit identically, never inventing a new predicate.
 */
function refreshOnlyDrift(
  evidence: VerificationEvidence | undefined,
  gitCwd: string,
  metadataRoot: string,
): string | null {
  if (!evidence || isWaiver(evidence)) return null;
  if (evidence.result !== 'pass') return null;
  const freshness = checkEvidenceFreshnessForGit(
    gitCwd,
    evidence.headHash,
    evidence.materialHash,
    metadataRoot,
    evidence.storyFilesHash,
  );
  return freshness.fresh ? null : (freshness.reason ?? 'evidence hash drift');
}

/**
 * After the single pass we re-read the row and reclassify. Returns:
 *   - 'fresh': the one pass re-stamped it to fresh.
 *   - { kind:'rerun_required' }: the row no longer proves pass (a failing/absent
 *     result) — must be RE-EXECUTED, which evidence_refresh never does.
 *   - { kind:'hard_stale' }: still result=pass but STILL not fresh by hash even
 *     after the re-stamp (material genuinely diverged) — needs a real re-run.
 */
function reclassifyAfterPass(
  evidence: VerificationEvidence | undefined,
  gitCwd: string,
  metadataRoot: string,
): 'fresh' | { kind: EscalationKind; reason: string } {
  if (!evidence || isWaiver(evidence) || evidence.result !== 'pass') {
    return {
      kind: 'rerun_required',
      reason: 'after one refresh pass the row has no passing evidence (failing/absent result); it must be re-executed, not refreshed',
    };
  }
  const freshness = checkEvidenceFreshnessForGit(
    gitCwd,
    evidence.headHash,
    evidence.materialHash,
    metadataRoot,
    evidence.storyFilesHash,
  );
  if (freshness.fresh) return 'fresh';
  return {
    kind: 'hard_stale',
    reason: `still stale by hash after one refresh pass (${freshness.reason ?? 'material drift'}); the underlying material genuinely diverged — re-run the command`,
  };
}

/** Collect the refresh-only candidates from the current checklist facts. */
function collectCandidates(
  checklist: ChecklistData,
  byRef: Map<string, VerificationEvidence>,
  gitCwd: string,
  metadataRoot: string,
): RefreshCandidate[] {
  const candidates: RefreshCandidate[] = [];
  for (const item of checklist.items) {
    for (const collected of collectVerificationIntents(item)) {
      const evidence = byRef.get(collected.ref);
      const drift = refreshOnlyDrift(evidence, gitCwd, metadataRoot);
      if (drift === null) continue;
      candidates.push({
        intentRef: collected.ref,
        itemId: collected.itemId,
        lane: collected.lane,
        priority: collected.intent.priority ?? 'must',
        driftReason: drift,
      });
    }
  }
  return candidates;
}

/**
 * Render the report honestly across THREE cases:
 *   (a) dry default (no --apply)                  → read-only preview, nothing written.
 *   (b) --apply with ≥1 candidate (a pass ran)    → one refresh pass via the writer.
 *   (c) --apply with 0 candidates (no pass ran)   → apply requested but nothing to
 *       refresh; explicitly states no evidence was written (must NOT claim a pass).
 *
 * `applyRequested` distinguishes (a) from (c): in both mode.writeEvidence is false,
 * but only (c) had --apply on. When omitted it is inferred from the report (any
 * write or non-empty refreshed/escalated implies a pass ran).
 */
export function renderEvidenceRefreshReport(
  report: EvidenceRefreshReport,
  applyRequested?: boolean,
): string {
  const passRan = report.mode.writeEvidence;
  const applyOn = applyRequested ?? (passRan || report.refreshed.length > 0 || report.escalated.length > 0);
  let modeLine: string;
  if (passRan) {
    modeLine = 'mode: apply (one refresh pass via verification_evidence_refresh_stale; no commands run)';
  } else if (applyOn) {
    modeLine = 'mode: apply requested — 0 refresh-only rows; nothing refreshed (no evidence written)';
  } else {
    modeLine = 'mode: dry preview (read-only; no commands run, no evidence written)';
  }
  const lines = [
    `Evidence refresh (${report.storyId})`,
    modeLine,
    `summary: candidates=${report.summary.candidates} refreshed=${report.summary.refreshed} escalated=${report.summary.escalated}`,
  ];

  const candidateLine = (c: RefreshCandidate): string =>
    `    - ${c.intentRef} [${c.priority}] drift: ${c.driftReason ?? 'evidence hash drift'}`;

  lines.push('', `refresh-only candidates (${report.candidates.length}):`);
  if (report.candidates.length === 0) lines.push('    none');
  else for (const c of report.candidates) lines.push(candidateLine(c));

  if (passRan) {
    lines.push('', `refreshed (${report.refreshed.length}):`);
    if (report.refreshed.length === 0) lines.push('    none');
    else for (const r of report.refreshed) lines.push(`    - ${r.intentRef} [${r.priority}] → fresh`);

    lines.push('', `escalated (${report.escalated.length}):`);
    if (report.escalated.length === 0) lines.push('    none');
    else for (const e of report.escalated) lines.push(`    - ${e.intentRef} [${e.priority}] ${e.outcome}: ${e.escalationReason}`);
  } else if (applyOn) {
    lines.push('', 'apply: requested but no refresh-only rows — no pass ran, no evidence written.');
  } else {
    lines.push('', 'apply: not requested (dry preview). Re-run with --apply to perform ONE refresh pass.');
  }

  lines.push('', 'Local assurance:');
  lines.push('  admissibilityStatus: refresh-preview');
  lines.push('  assuranceLevel: local');
  lines.push('  evidenceScope: verification-evidence');
  return lines.join('\n');
}

export function createEvidenceRefreshHandlers(ctx: HandlerContext): Record<string, (...args: any[]) => any> {
  function evidenceRefresh(args: EvidenceRefreshArgs): EvidenceRefreshReport | string {
    assertBoundary(args);

    // Story-existence guard BEFORE any classification/preview/write. readChecklist
    // swallows errors so an existing-but-checklist-less story still previews empty;
    // but a genuinely MISSING story must error clearly instead of returning a
    // silent empty no-op (CHK-001:edge:2). This runs before any --apply pass, so
    // no write can have happened.
    if (!ctx.store.storyExists(args.storyId)) {
      throw new Error(`evidence_refresh: story ${args.storyId} not found`);
    }

    const apply = wantsApply(args);
    const gitCwd = resolveGitCwd({
      store: ctx.store,
      storyId: args.storyId,
      metadataRoot: ctx.root,
      projectRoot: ctx.root,
    });

    // 1. Detect the refresh-only bucket from CURRENT facts (the rows ONE pass
    //    could re-stamp). This is the dry preview and the apply input set.
    const beforeChecklist = readChecklist(ctx, args.storyId);
    const candidates = collectCandidates(
      beforeChecklist,
      evidenceByIntentRef(beforeChecklist),
      gitCwd,
      ctx.root,
    );

    const refreshed: RefreshedRow[] = [];
    const escalated: EscalatedRow[] = [];

    // A refresh pass ACTUALLY runs only when --apply is requested AND there is at
    // least one refresh-only candidate. writeEvidence must reflect that real fact
    // (not just the --apply flag): --apply with 0 candidates writes nothing.
    const didWrite = apply && candidates.length > 0;

    if (didWrite) {
      // 2. Perform AT MOST ONE refresh pass via the EXISTING writer. We do NOT
      //    add a new mutation primitive and never re-stamp a row twice: this is
      //    a single dryRun:false call that re-stamps every stale-by-hash row.
      createChecklistHandlers(ctx).verification_evidence_refresh_stale({ storyId: args.storyId });

      // 3. RE-READ + RECLASSIFY each previously refresh-only row from current
      //    facts. Fresh → refreshed; still-not-fresh → escalate (no loop, no
      //    second pass, no command execution).
      const afterChecklist = readChecklist(ctx, args.storyId);
      const afterByRef = evidenceByIntentRef(afterChecklist);
      for (const candidate of candidates) {
        const verdict = reclassifyAfterPass(afterByRef.get(candidate.intentRef), gitCwd, ctx.root);
        if (verdict === 'fresh') {
          refreshed.push({ ...candidate, outcome: 'refreshed' });
        } else {
          escalated.push({ ...candidate, outcome: verdict.kind, escalationReason: verdict.reason });
        }
      }
    }

    const report: EvidenceRefreshReport = {
      storyId: args.storyId,
      mode: { runCommands: false, writeEvidence: didWrite },
      candidates,
      refreshed,
      escalated,
      summary: {
        candidates: candidates.length,
        refreshed: refreshed.length,
        escalated: escalated.length,
      },
      claims: {
        authorityDone: false,
        fullAuthorityDone: false,
        productionDone: false,
      },
    };

    return wantsJson(args) ? report : renderEvidenceRefreshReport(report, apply);
  }

  return {
    evidence_refresh: evidenceRefresh,
  };
}
