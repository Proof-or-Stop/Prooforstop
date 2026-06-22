import type { DoneCheckRow } from '../core/done-oracle.js';
import { buildDoneChecklist } from '../core/done-oracle.js';
import type { StoryInfo } from '../core/types.js';
import type { HandlerContext } from './context.js';
import { currentGitHead, currentMaterialHash } from '../core/evidence-freshness.js';
import { loadAuthoritySettings } from '../core/authority-mode.js';
import { loadConfig } from '../core/config.js';
import { resolveWorkflowPolicy } from '../core/workflow-policy.js';
import {
  DEFAULT_AUTHORITY_RECEIPT_MAX_VERIFIED_AGE_MS,
  consumeAuthorityGateReceiptDocument,
  type AuthorityGateReceiptFailReason,
} from '../core/authority-gate-receipts.js';

type DoneClosureStatus = 'notRequired' | 'required' | 'passed' | 'blocked';
type AuthorityImpact = 'none' | 'localOnly' | 'requiresAuthorityReceipt';
type DoneClosureFormatArgs = { format?: 'text' | 'json'; json?: boolean };

export interface DoneClosureBlocker {
  id: string;
  status: DoneCheckRow['status'];
  source: string;
  reason: string;
  nextCommand?: string;
  authorityImpact: AuthorityImpact;
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
  authorityServerPath: {
    required: boolean;
    receiptVerified: boolean;
    receiptRefs: string[];
    mayClaimAuthorityDone: boolean;
  };
  readOnly: true;
  note: 'local DONE readiness is not Authority DONE readiness';
}

function wantsJson(args: DoneClosureFormatArgs | undefined): boolean {
  return args?.json === true || args?.format === 'json';
}

function rowAuthorityImpact(row: DoneCheckRow): AuthorityImpact {
  if (row.id.includes('authority') || row.source.includes('authority')) return 'requiresAuthorityReceipt';
  if (row.blocking || row.status === 'fail') return 'localOnly';
  return 'none';
}

function nextCommandForRow(storyId: string, row: DoneCheckRow): string | undefined {
  switch (row.id) {
    case 'test-evidence':
    case 'evidence-freshness':
    case 'verification-intent-coverage':
      return `lattice validate --story=${storyId} --json`;
    case 'bugs-fixed':
      return `lattice bug_list '{"storyId":"${storyId}"}'`;
    case 'git-working-tree':
      return 'git status --short';
    case 'branch-synced-main':
      return 'git merge main';
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
    authorityImpact: rowAuthorityImpact(row),
    blocking: row.blocking,
  };
}

function receiptRefsForStory(ctx: HandlerContext, storyId: string): string[] {
  const document = ctx.store.readAuthorityReceiptRefs(storyId);
  return (document?.refs ?? [])
    .map((ref) => ref.receiptId || ref.decisionDigest || ref.decisionId || ref.status)
    .filter((value): value is string => typeof value === 'string' && value.length > 0);
}

function authorityReceiptProjection(ctx: HandlerContext, storyId: string, story: StoryInfo): {
  required: boolean;
  receiptVerified: boolean;
  receiptRefs: string[];
  mayClaimAuthorityDone: boolean;
  blocking: boolean;
} {
  const settings = ctx.authoritySettings ?? loadAuthoritySettings(process.env);
  const required = settings.mode === 'enforce';
  const receiptRefs = receiptRefsForStory(ctx, storyId);
  if (settings.mode === 'off') {
    return {
      required,
      receiptVerified: false,
      receiptRefs,
      mayClaimAuthorityDone: false,
      blocking: false,
    };
  }

  const headHash = currentGitHead(ctx.root);
  const materialHash = currentMaterialHash(ctx.root);
  let reason: AuthorityGateReceiptFailReason | undefined;
  let receiptVerified = false;
  if (!headHash || !materialHash) {
    reason = !headHash ? 'authority_receipt_head_mismatch' : 'authority_receipt_stale_material';
  } else {
    const policy = resolveWorkflowPolicy(loadConfig(ctx.root), story);
    const now = new Date().toISOString();
    const consumed = consumeAuthorityGateReceiptDocument(
      ctx.store.readAuthorityReceiptRefs(storyId) ?? undefined,
      {
        storyId,
        targetPhase: 'DONE',
        headHash,
        materialHash,
        now,
        maxVerifiedAgeMs: DEFAULT_AUTHORITY_RECEIPT_MAX_VERIFIED_AGE_MS,
        acceptablePolicyModes: [policy.profile],
        acceptableAuthorityModes: ['enforce'],
      },
      now,
    );
    reason = consumed.reason;
    receiptVerified = consumed.consumed;
  }

  return {
    required,
    receiptVerified,
    receiptRefs,
    mayClaimAuthorityDone: false,
    blocking: required && (!receiptVerified || reason !== undefined),
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
  const rows = buildDoneChecklist(storyId, ctx.store, ctx.root, { auditWriter: null });
  const blockers = rows.map((row) => toBlocker(storyId, row));
  const blockingRows = blockers.filter((row) => row.blocking && row.status === 'fail');
  const evidenceRefs = [...new Set(rows
    .filter((row) => row.status === 'pass' && row.source)
    .map((row) => row.source))];
  const authorityServerPath = authorityReceiptProjection(ctx, storyId, story);

  return {
    schemaVersion: 'lattice.done_closure.v1',
    storyId,
    phase: story.phase,
    canAttemptDone: story.phase === 'TEST' && blockingRows.length === 0 && !authorityServerPath.blocking,
    blockers,
    localNonAuthorityAudit: {
      status: localAuditStatus(story.phase, blockingRows),
      requiredHosts: ['local-cli'],
      requiredRounds: 1,
      evidenceRefs,
    },
    authorityServerPath: {
      required: authorityServerPath.required,
      receiptVerified: authorityServerPath.receiptVerified,
      receiptRefs: authorityServerPath.receiptRefs,
      mayClaimAuthorityDone: authorityServerPath.mayClaimAuthorityDone,
    },
    readOnly: true,
    note: 'local DONE readiness is not Authority DONE readiness',
  };
}

function renderDoneClosure(runbook: DoneClosureRunbook): string {
  const blocking = runbook.blockers.filter((row) => row.blocking && row.status === 'fail');
  const lines = [
    `DONE closure (${runbook.schemaVersion})`,
    `storyId: ${runbook.storyId}`,
    `phase: ${runbook.phase}`,
    `canAttemptDone: ${runbook.canAttemptDone}`,
    `readOnly: ${runbook.readOnly}`,
    runbook.note,
    '',
    `localNonAuthorityAudit: ${runbook.localNonAuthorityAudit.status}`,
    `  evidenceRefs: ${(runbook.localNonAuthorityAudit.evidenceRefs ?? []).join(', ') || 'none'}`,
    '',
    'Authority Server path:',
    `  required: ${runbook.authorityServerPath.required}`,
    `  receiptVerified: ${runbook.authorityServerPath.receiptVerified}`,
    `  receiptRefs: ${runbook.authorityServerPath.receiptRefs.join(', ') || 'none'}`,
    `  mayClaimAuthorityDone: ${runbook.authorityServerPath.mayClaimAuthorityDone}`,
    '',
    `DONE oracle rows: ${runbook.blockers.length} (${blocking.length} blocking)`,
  ];
  for (const row of runbook.blockers) {
    const marker = row.status === 'pass' ? 'PASS' : (row.status === 'fail' ? 'FAIL' : 'warn');
    lines.push(`  [${marker}] ${row.id}: ${row.reason}`);
    lines.push(`        source: ${row.source}; blocking=${row.blocking}; authorityImpact=${row.authorityImpact}`);
    if (row.nextCommand) lines.push(`        next: ${row.nextCommand}`);
  }
  return lines.join('\n');
}

export function createDoneClosureHandlers(ctx: HandlerContext): Record<string, (...args: any[]) => any> {
  return {
    done_closure(args: { storyId: string } & DoneClosureFormatArgs) {
      const runbook = buildDoneClosureRunbook(ctx, args.storyId);
      if (wantsJson(args)) return runbook;
      return renderDoneClosure(runbook);
    },
  };
}
