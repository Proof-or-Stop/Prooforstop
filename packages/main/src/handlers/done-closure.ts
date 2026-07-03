import type { DoneCheckRow } from '../core/done-oracle.js';
import { buildDoneChecklist } from '../core/done-oracle.js';
import {
  resolveCompletedReviewEscalationSnapshot,
  type CompletedReviewEscalationSnapshot,
} from '../core/review-escalation.js';
import type { StoryInfo } from '../core/types.js';
import { buildMemoryFreshnessPack, renderMemoryFreshnessPackSummary, type MemoryFreshnessPack } from '../core/playbook-runtime-memory.js';
import { surfaceRuntimeMemoryPack } from '../core/experience-pack-surface.js';
import type { HandlerContext } from './context.js';

type DoneClosureStatus = 'notRequired' | 'required' | 'passed' | 'blocked';
type AssuranceImpact = 'none' | 'localEvidence';
type DoneClosureFormatArgs = { format?: 'text' | 'json'; json?: boolean };
const DONE_PREPARE_BLOCKER_IDS = new Set(['evidence-freshness', 'done-required-validation', 'branch-synced-main']);
const POST_DONE_CURRENT_REVALIDATION_ROW_IDS = new Set([
  'done-required-validation',
  'delivery-check',
  'review-escalation',
  'review-assurance-floor',
]);

export interface DoneClosureBlocker {
  id: string;
  status: DoneCheckRow['status'];
  source: string;
  reason: string;
  nextCommand?: string;
  assuranceImpact: AssuranceImpact;
  blocking: boolean;
}

export interface DoneClosureRunbook {
  schemaVersion: 'lattice.done_closure.v1';
  storyId: string;
  phase: StoryInfo['phase'];
  canAttemptDone: boolean;
  blockers: DoneClosureBlocker[];
  localNonAuthorityAudit: {
    status: DoneClosureStatus;
    requiredHosts?: string[];
    requiredRounds?: number;
    evidenceRefs?: string[];
  };
  localAssurance: {
    admissibilityStatus: 'local-admissible' | 'blocked';
    assuranceLevel: 'local';
    evidenceScope: 'local-gate-evidence';
    receiptBundleRequired: boolean;
    quorumRequired: boolean;
  };
  memoryFreshnessPack: MemoryFreshnessPack;
  completionClaimSource: 'ParentRollupResult/current-structured-facts';
  historicalSnapshot?: CompletedReviewEscalationSnapshot;
  readOnly: true;
  note: 'local DONE readiness is based on proof admissibility, receipt-bundle checks, and local quorum evidence';
}

function wantsJson(args: DoneClosureFormatArgs | undefined): boolean {
  return args?.json === true || args?.format === 'json';
}

function rowAssuranceImpact(row: DoneCheckRow): AssuranceImpact {
  if (row.blocking || row.status === 'fail') return 'localEvidence';
  return 'none';
}

function donePrepareCommand(storyId: string): string {
  return `lattice done_prepare '{"storyId":"${storyId}","mergeMain":true,"refreshStale":true,"validate":true}'`;
}

function isDonePrepareRecoveryBlocker(row: DoneCheckRow): boolean {
  return row.blocking && row.status === 'fail' && DONE_PREPARE_BLOCKER_IDS.has(row.id);
}

function nextCommandForRow(storyId: string, row: DoneCheckRow): string | undefined {
  if (isDonePrepareRecoveryBlocker(row)) return donePrepareCommand(storyId);
  switch (row.id) {
    case 'test-evidence':
    case 'verification-intent-coverage':
      return `lattice validate --story=${storyId} --json`;
    case 'evidence-freshness':
    case 'done-required-validation':
    case 'branch-synced-main':
      return row.blocking ? row.hint : undefined;
    case 'bugs-fixed':
      return `lattice bug_list '{"storyId":"${storyId}"}'`;
    case 'git-working-tree':
      return 'git status --short';
    case 'delivery-check':
      return 'lattice delivery_check_set ...';
    case 'story-summary':
      return `lattice summary_set '{"storyId":"${storyId}",...}'`;
    case 'declared-artifacts-referenced':
    case 'declared-artifacts-committed':
      return 'lattice artifact_declare ...';
    case 'eval-evidence':
      return `lattice evaluate '{"storyId":"${storyId}"}'`;
    case 'codex-adapter-evidence':
      return `lattice verify_codex '{"storyId":"${storyId}"}'`;
    default:
      return row.hint;
  }
}

function toBlocker(storyId: string, row: DoneCheckRow): DoneClosureBlocker {
  const reason = [row.label, row.detail].filter(Boolean).join(': ');
  return {
    id: row.id,
    status: row.status,
    source: row.source,
    reason,
    nextCommand: nextCommandForRow(storyId, row),
    assuranceImpact: rowAssuranceImpact(row),
    blocking: row.blocking,
  };
}

function isCurrentMaterialRevalidationFailure(row: DoneCheckRow): boolean {
  if (!POST_DONE_CURRENT_REVALIDATION_ROW_IDS.has(row.id)) return false;
  if (row.status !== 'fail' || !row.blocking) return false;
  const text = `${row.detail ?? ''}\n${row.hint ?? ''}`.toLowerCase();
  if (
    text.includes('missing materialhash') ||
    text.includes('missing-materialhash') ||
    text.includes('missing storyfileshash') ||
    text.includes('missing-storyfileshash') ||
    text.includes('missing delivery-check') ||
    text.includes('_hash mismatch') ||
    text.includes('tampered')
  ) {
    return false;
  }
  return (
    text.includes('stale') ||
    text.includes('drift') ||
    text.includes('materialdigest') ||
    text.includes('receipt-cwd-mismatch') ||
    text.includes('current material')
  );
}

function projectHistoricalDoneRow(row: DoneCheckRow): DoneCheckRow {
  if (!isCurrentMaterialRevalidationFailure(row)) return row;
  return {
    ...row,
    status: 'warn',
    blocking: false,
    detail: `historical DONE closure preserved; current-material revalidation advisory: ${row.detail ?? row.label}`,
    hint: [
      'This story is already DONE. Historical closure is evaluated against the DONE snapshot.',
      row.hint ? `Current-material revalidation guidance: ${row.hint}` : '',
    ].filter(Boolean).join('\n'),
  };
}

function localAuditStatus(phase: StoryInfo['phase'], blockingRows: DoneClosureBlocker[]): DoneClosureStatus {
  if (phase === 'DONE') return 'notRequired';
  if (blockingRows.length > 0) return 'blocked';
  if (phase === 'TEST') return 'passed';
  return 'required';
}

export function buildDoneClosureRunbook(ctx: HandlerContext, storyId: string): DoneClosureRunbook {
  const story = ctx.store.readStory(storyId);
  const historicalSnapshot = resolveCompletedReviewEscalationSnapshot({
    storyId,
    store: ctx.store,
  });
  const rawRows = buildDoneChecklist(storyId, ctx.store, ctx.root, {
    auditWriter: null,
    ...(historicalSnapshot ? {
      completedSnapshot: {
        materialHash: historicalSnapshot.materialHash,
        storyFilesHash: historicalSnapshot.storyFilesHash,
      },
    } : {}),
  });
  const rows = story.phase === 'DONE'
    ? rawRows.map(projectHistoricalDoneRow)
    : rawRows;
  const blockers = rows.map((row) => toBlocker(storyId, row));
  const blockingRows = blockers.filter((row) => row.blocking && row.status === 'fail');
  const evidenceRefs = [...new Set(rows
    .filter((row) => row.status === 'pass' && row.source)
    .map((row) => row.source))];
  const memoryFreshnessPack = buildMemoryFreshnessPack({
    projectRoot: ctx.root,
    consumer: 'done_closure',
    storyPhase: story.phase,
    query: [
      `story:${storyId}`,
      story.title,
      story.description,
      'done closure intent-totality delivery parent roadmap ParentRollupResult current structured facts memory non-authoritative',
    ].join('\n'),
    maxEntries: 5,
    maxPlaybooks: 5,
    maxLines: 60,
  });

  return {
    schemaVersion: 'lattice.done_closure.v1',
    storyId,
    phase: story.phase,
    canAttemptDone: story.phase === 'TEST' && blockingRows.length === 0,
    blockers,
    localNonAuthorityAudit: {
      status: localAuditStatus(story.phase, blockingRows),
      requiredHosts: ['local-cli'],
      requiredRounds: 1,
      evidenceRefs,
    },
    localAssurance: {
      admissibilityStatus: blockingRows.length === 0 ? 'local-admissible' : 'blocked',
      assuranceLevel: 'local',
      evidenceScope: 'local-gate-evidence',
      receiptBundleRequired: false,
      quorumRequired: false,
    },
    memoryFreshnessPack,
    completionClaimSource: 'ParentRollupResult/current-structured-facts',
    ...(story.phase === 'DONE' && historicalSnapshot ? { historicalSnapshot } : {}),
    readOnly: true,
    note: 'local DONE readiness is based on proof admissibility, receipt-bundle checks, and local quorum evidence',
  };
}

function renderDoneClosure(runbook: DoneClosureRunbook, showMemoryPack = true): string {
  const blocking = runbook.blockers.filter((row) => row.blocking && row.status === 'fail');
  const lines = [
    `DONE closure (${runbook.schemaVersion})`,
    `storyId: ${runbook.storyId}`,
    `phase: ${runbook.phase}`,
    `canAttemptDone: ${runbook.canAttemptDone}`,
    `readOnly: ${runbook.readOnly}`,
    ...(runbook.historicalSnapshot ? [
      `projection: historical DONE snapshot (${runbook.historicalSnapshot.source})`,
      `snapshotMaterialHash: ${runbook.historicalSnapshot.materialHash}`,
      `snapshotStoryFilesHash: ${runbook.historicalSnapshot.storyFilesHash ?? '<missing>'}`,
    ] : []),
    runbook.note,
    '',
    `localAssuranceAudit: ${runbook.localNonAuthorityAudit.status}`,
    `  evidenceRefs: ${(runbook.localNonAuthorityAudit.evidenceRefs ?? []).join(', ') || 'none'}`,
    '',
    'Local assurance:',
    `  admissibilityStatus: ${runbook.localAssurance.admissibilityStatus}`,
    `  assuranceLevel: ${runbook.localAssurance.assuranceLevel}`,
    `  evidenceScope: ${runbook.localAssurance.evidenceScope}`,
    `  receiptBundleRequired: ${runbook.localAssurance.receiptBundleRequired}`,
    `  quorumRequired: ${runbook.localAssurance.quorumRequired}`,
    '',
    `DONE oracle rows: ${runbook.blockers.length} (${blocking.length} blocking)`,
  ];
  for (const row of runbook.blockers) {
    const marker = row.status === 'pass' ? 'PASS' : (row.status === 'fail' ? 'FAIL' : 'warn');
    lines.push(`  [${marker}] ${row.id}: ${row.reason}`);
    lines.push(`        source: ${row.source}; blocking=${row.blocking}; assuranceImpact=${row.assuranceImpact}`);
    if (row.nextCommand) lines.push(`        next: ${row.nextCommand}`);
  }
  // B-ab8d CHK-002: control arm hides the rendered memory summary section
  // only; the runbook JSON keeps the pack for lossless measurement.
  if (showMemoryPack) {
    lines.push(
      '',
      'Advisory memory considered:',
      ...renderMemoryFreshnessPackSummary(runbook.memoryFreshnessPack).split('\n').map((line) => `  ${line}`),
      `  completionClaimSource: ${runbook.completionClaimSource}`,
      '  memoryCompletionProof: false',
    );
  }
  return lines.join('\n');
}

export function createDoneClosureHandlers(ctx: HandlerContext): Record<string, (...args: any[]) => any> {
  return {
    done_closure(args: { storyId: string } & DoneClosureFormatArgs) {
      const runbook = buildDoneClosureRunbook(ctx, args.storyId);
      // B-ab8d CHK-002: experiment-arm surfacing at the done_closure
      // entrypoint — the runbook pack is already computed; fire the
      // once-per-key event on both arms, gate only the rendered section.
      const packSurface = surfaceRuntimeMemoryPack(ctx.root, {
        consumer: 'done_closure',
        storyId: args.storyId,
        roundKey: runbook.phase,
        buildPack: () => runbook.memoryFreshnessPack,
      });
      if (wantsJson(args)) return runbook;
      return renderDoneClosure(runbook, packSurface.shouldRender);
    },
  };
}
