import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { HandlerContext } from './context.js';
import {
  buildStoryReadinessReport,
  type StoryReadinessReport,
  type StoryReadinessRow,
} from '../core/lifecycle-readiness.js';
import { isCanonicalStoryId } from '../core/lifecycle-registry.js';
import { resolveGitCwd } from '../core/story-signed-workspace-resolution.js';
import type { ChecklistData } from '../core/types.js';

/**
 * P6 — `delivery_context_pack`: the delivery-review CONTEXT PRODUCER for the
 * Lifecycle Readiness plan.
 *
 *   lattice delivery_context_pack --storyId=B-xxxx [--write] [--format=text|json]
 *
 * Default (no --write) is READ-ONLY: it gathers and prints the structured
 * delivery context pack the delivery reviewer needs — the delivery-scoped git
 * diff vs main, the docs-promises (from plan.md + checklist userSees), the
 * real-machine test refs (transcript-diff.md presence, story smoke/test files,
 * verificationEvidence commands), the validation + review-round state, and the
 * CURRENT delivery-check + metadata-waiver status CONSUMED from the existing V1
 * StoryReadinessReport deliveryCheckRef (it never invents a new readiness
 * predicate). runCommands=false, writeEvidence=false. It mutates nothing.
 *
 * --write is the OPT-IN artifact writer (ownership/scope gated by the CLI gate):
 * it persists the SAME structured pack to <storyDir>/evidence/delivery-context-pack.json
 * via an atomic write (temp -> validate-parse -> rename), leaving no .tmp residue.
 *
 * CRITICAL — it is a context PRODUCER, NOT a delivery SIGNER. It NEVER writes
 * delivery-check.json, NEVER calls the delivery-check setter / delivery_check_set,
 * and NEVER accepts or rejects a metadata-only waiver (those are the delivery
 * reviewer's exclusive job). It NEVER runs a command (runCommands=false), advances
 * phase, launches reviewers, claims Authority, or writes verificationEvidence.
 * retired completion fields are hardcoded false.
 */

const READINESS_TARGET = 'DONE' as const;
const PACK_ARTIFACT = 'evidence/delivery-context-pack.json';
const TRANSCRIPT_DIFF_REL = 'evidence/transcript-diff.md';
const DIFF_SUMMARY_MAX = 4000;

interface DeliveryContextPackArgs {
  storyId: string;
  write?: boolean;
  format?: 'text' | 'json';
  json?: boolean;
  runCommands?: boolean;
  writeEvidence?: boolean;
  advancePhase?: boolean;
  launchReviewers?: boolean;
  authorityDone?: boolean;
  fullAuthorityDone?: boolean;
  productionDone?: boolean;
}

interface DeliveryDocsPromise {
  /** Where the promise was sourced from. */
  source: 'plan.md' | 'userSees';
  /** The user-visible promise text. */
  promise: string;
}

interface DeliveryRealMachineTests {
  /** Whether evidence/transcript-diff.md exists in the story dir. */
  transcriptDiff: boolean;
  /** Story-declared smoke/test files from checklist files.test. */
  testFiles: string[];
  /** Commands recorded on verificationEvidence (the actual-machine refs). */
  evidenceCommands: string[];
}

interface DeliveryDiff {
  changedFiles: string[];
  summary: string;
}

interface DeliveryCheckStatus {
  /** Derived from the V1 delivery-check readiness row (consumed, not re-derived). */
  status: 'present' | 'missing' | 'stale' | 'blocking' | 'unknown';
  /** The V1 report.artifacts.deliveryCheckRef, surfaced verbatim. */
  ref: Record<string, unknown> | null;
}

export interface DeliveryContextPackReport {
  storyId: string;
  generatedFor: 'delivery-review';
  phase: StoryReadinessReport['phase'];
  mode: {
    /** Always false: delivery_context_pack NEVER runs a command. */
    runCommands: false;
    /** true IFF --write persisted the artifact this invocation. */
    writeEvidence: boolean;
  };
  /** The delivery-scoped git diff vs main. */
  diff: DeliveryDiff;
  /** Docs-promises authored in plan.md + checklist userSees. */
  docsPromises: DeliveryDocsPromise[];
  /** Real-machine test refs (transcript-diff presence, test files, evidence commands). */
  realMachineTests: DeliveryRealMachineTests;
  /** Validation state, CONSUMED from the V1 readiness reader. */
  validation: StoryReadinessReport['artifacts']['validationRef'];
  /** Current review round, CONSUMED from the V1 readiness reader. */
  reviewRound: string | null;
  /** Delivery-check status CONSUMED from the V1 delivery-check row + deliveryCheckRef. */
  deliveryCheck: DeliveryCheckStatus;
  /** Metadata-only waiver status, SURFACED only (never accepted/rejected here). */
  waiver: { status: 'surfaced' | 'none'; ref: StoryReadinessReport['artifacts']['metadataOnlyWaiverRef'] };
  /** The V1 delivery-check readiness row, CONSUMED from the readiness reader. */
  deliveryReadinessRow: StoryReadinessRow | null;
  /** Hardcoded false: this command is a context producer, never a delivery signer. */
  isSigner: false;
  /** The write outcome: requested + whether it actually persisted + the path. */
  write: {
    requested: boolean;
    persisted: boolean;
    artifactPath: string | null;
  };
  claims: {
    authorityDone: false;
    fullAuthorityDone: false;
    productionDone: false;
  };
}

/** The persisted artifact shape (a subset of the report — no transient mode/write echo). */
interface PersistedDeliveryContextPackArtifact {
  storyId: string;
  generatedFor: 'delivery-review';
  diff: DeliveryDiff;
  docsPromises: DeliveryDocsPromise[];
  realMachineTests: DeliveryRealMachineTests;
  validation: StoryReadinessReport['artifacts']['validationRef'];
  reviewRound: string | null;
  deliveryCheck: { status: DeliveryCheckStatus['status']; ref: Record<string, unknown> | null };
  waiver: { status: 'surfaced' | 'none' };
  isSigner: false;
  claims: { authorityDone: false; fullAuthorityDone: false; productionDone: false };
}

function wantsJson(args: DeliveryContextPackArgs): boolean {
  return args.json === true || args.format === 'json';
}

function wantsWrite(args: DeliveryContextPackArgs): boolean {
  return args.write === true || (args.write as unknown) === 'true';
}

/**
 * Fail closed BEFORE any store read. delivery_context_pack is a context producer
 * with exactly ONE sanctioned opt-in (--write, which the CLI ownership gate guards
 * as a story-scoped mutation); every OTHER side effect is refused. In particular a
 * bare runCommands/writeEvidence flag is rejected here: this command never runs a
 * command, and persistence is the explicit --write opt-in, never a raw
 * writeEvidence=true. As a context PRODUCER it can never become a delivery signer,
 * so advancePhase/launchReviewers/authority/production are all refused.
 */
function assertBoundary(args: DeliveryContextPackArgs): void {
  const rejected: string[] = [];
  if (args.runCommands === true) rejected.push('runCommands=true');
  if (args.writeEvidence === true) rejected.push('writeEvidence=true');
  if (args.advancePhase === true) rejected.push('advancePhase=true');
  if (args.launchReviewers === true) rejected.push('launchReviewers=true');
  if (args.authorityDone === true) rejected.push('authorityDone=true');
  if (args.fullAuthorityDone === true) rejected.push('fullAuthorityDone=true');
  if (args.productionDone === true) rejected.push('productionDone=true');
  if (rejected.length === 0) return;
  throw new Error(
    `delivery_context_pack refuses unsupported side effects: ${rejected.join(' and ')}. ` +
    'delivery_context_pack is a delivery-review context PRODUCER, NOT a delivery signer: it never runs a command, ' +
    'writes delivery-check.json / calls delivery_check_set, accepts or rejects a metadata-only waiver, advances a phase, ' +
    'launches reviewers, writes verificationEvidence, or claims Authority/production completion: no story facts were read. ' +
    'Persisting the structured pack is the explicit --write opt-in (ownership/scope gated).',
  );
}

function assertSafeStoryId(storyId: unknown): asserts storyId is string {
  if (
    typeof storyId !== 'string' ||
    storyId.includes('/') ||
    storyId.includes('\\') ||
    storyId.includes('..') ||
    !isCanonicalStoryId(storyId)
  ) {
    throw new Error(
      `delivery_context_pack: invalid storyId ${JSON.stringify(storyId)} ` +
      '(expected B-..., B-META-..., ADHOC-..., TOOL-..., or META-... without path traversal)',
    );
  }
}

function readChecklist(ctx: HandlerContext, storyId: string): ChecklistData {
  try {
    return ctx.store.readChecklist(storyId);
  } catch {
    return { items: [] };
  }
}

function git(gitCwd: string, args: string[]): string {
  try {
    return execFileSync('git', args, { cwd: gitCwd, encoding: 'utf8' }).trimEnd();
  } catch {
    return '';
  }
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, Math.max(0, max))}\n...[truncated ${value.length - max} chars]`;
}

/**
 * Delivery-scoped diff vs main: changed files + a bounded summary. Mirrors the
 * verification-context-pack diff approach (git name-only + a unified diff), but
 * scoped to the delivery review (vs the merge-base of main) and never executed as
 * a "command" the command-policy would consider runCommands — it is the same
 * read-only git introspection the readiness reader already performs.
 */
function deliveryScopedDiff(gitCwd: string): DeliveryDiff {
  // Prefer the merge-base of main so the diff reflects the story's delivery
  // contribution; fall back to a plain `main` compare, then HEAD, then empty.
  const base =
    git(gitCwd, ['merge-base', 'HEAD', 'main']) ||
    git(gitCwd, ['rev-parse', 'main']) ||
    'HEAD';
  const nameOnly = git(gitCwd, ['diff', '--name-only', base]);
  const changedFiles = [...new Set(nameOnly.split('\n').filter(Boolean))].sort();
  const stat = git(gitCwd, ['diff', '--stat', base]);
  const summary = truncate(stat, DIFF_SUMMARY_MAX);
  return { changedFiles, summary };
}

/** Extract docs-promise lines from plan.md: bullet/line items under a Promise/Docs section. */
function planDocsPromises(ctx: HandlerContext, storyId: string): DeliveryDocsPromise[] {
  let planText: string;
  try {
    planText = readFileSync(ctx.store.storyFilePath(storyId, 'plan.md'), 'utf8');
  } catch {
    return [];
  }
  const promises: DeliveryDocsPromise[] = [];
  const seen = new Set<string>();
  for (const raw of planText.split('\n')) {
    const line = raw.trim();
    // Recognize authored docs-promise lines: a leading "promise"/"docs"/"user
    // sees" marker. This is read-only consumption of authored PLAN metadata,
    // never synthesized prose.
    const match = line.match(/^(?:[-*]\s*)?(?:\*\*)?(?:promise|docs?\s*promise|user\s*sees?)(?:\*\*)?\s*[:：]\s*(.+)$/i);
    if (!match) continue;
    const promise = match[1].trim();
    if (promise.length === 0 || seen.has(promise)) continue;
    seen.add(promise);
    promises.push({ source: 'plan.md', promise });
  }
  return promises;
}

/** Collect docs-promises from the checklist userSees (the user-visible output each item promises). */
function userSeesDocsPromises(checklist: ChecklistData): DeliveryDocsPromise[] {
  const promises: DeliveryDocsPromise[] = [];
  const seen = new Set<string>();
  for (const item of checklist.items) {
    const sees = typeof item.userSees === 'string' ? item.userSees.trim() : '';
    if (sees.length === 0 || seen.has(sees)) continue;
    seen.add(sees);
    promises.push({ source: 'userSees', promise: sees });
  }
  return promises;
}

/** Real-machine test refs: transcript-diff presence + story test files + evidence commands. */
function realMachineTests(ctx: HandlerContext, storyId: string, checklist: ChecklistData): DeliveryRealMachineTests {
  const transcriptDiff = existsSync(ctx.store.storyFilePath(storyId, TRANSCRIPT_DIFF_REL));

  const testFiles = new Set<string>();
  const evidenceCommands = new Set<string>();
  for (const item of checklist.items) {
    for (const file of item.files?.test ?? []) {
      if (typeof file === 'string' && file.trim().length > 0) testFiles.add(file.trim());
    }
    for (const ev of item.verificationEvidence ?? []) {
      const command = typeof ev.command === 'string' ? ev.command.trim() : '';
      if (command.length > 0) evidenceCommands.add(command);
    }
  }
  return {
    transcriptDiff,
    testFiles: [...testFiles].sort(),
    evidenceCommands: [...evidenceCommands].sort(),
  };
}

/**
 * Pick the V1 delivery-check readiness row from the readiness reader (consume,
 * never re-derive). The existing reader emits one of the delivery-check codes
 * (missing/stale/docs-promise/passed/blocking); this command surfaces that.
 */
function deliveryReadinessRow(report: StoryReadinessReport): StoryReadinessRow | null {
  return (
    report.readiness.find(
      (r) => r.id === 'done.delivery-check' || r.code.includes('delivery_check') || r.code === 'docs_promise_unresolved',
    ) ?? null
  );
}

/**
 * Derive the delivery-check STATUS purely from the V1 row + deliveryCheckRef. No
 * new readiness predicate is invented: the existing delivery-check codes map to a
 * stable status label, and the ref is the V1 artifacts.deliveryCheckRef verbatim.
 */
function deliveryCheckStatus(report: StoryReadinessReport, row: StoryReadinessRow | null): DeliveryCheckStatus {
  const ref = report.artifacts.deliveryCheckRef;
  let status: DeliveryCheckStatus['status'];
  if (!row) {
    // No DONE-target delivery row available (e.g. target below DONE): fall back to
    // ref presence only — present iff the V1 reader surfaced a deliveryCheckRef.
    status = ref ? 'present' : 'unknown';
  } else if (row.code === 'missing_delivery_check') {
    status = 'missing';
  } else if (row.code === 'stale_delivery_check') {
    status = 'stale';
  } else if (row.code === 'delivery_check_passed') {
    status = 'present';
  } else {
    // docs_promise_unresolved / delivery_check_blocking and any other delivery row.
    status = 'blocking';
  }
  return { status, ref };
}

/**
 * Persist the structured delivery context pack atomically: write temp ->
 * validate-parse -> renameSync to final, unlinking the temp on any failure so the
 * evidence dir holds exactly one artifact with no .tmp residue. This is the ONLY
 * write path and is reached only on --write (CLI-ownership-gated). It NEVER writes
 * delivery-check.json and NEVER calls the delivery-check setter.
 */
function persistArtifact(artifactPath: string, artifact: PersistedDeliveryContextPackArtifact): void {
  mkdirSync(dirname(artifactPath), { recursive: true });
  const serialized = JSON.stringify(artifact, null, 2) + '\n';
  const tmpPath = `${artifactPath}.tmp-${process.pid}-${Date.now()}`;
  try {
    writeFileSync(tmpPath, serialized, 'utf8');
    JSON.parse(readFileSync(tmpPath, 'utf8'));
    renameSync(tmpPath, artifactPath);
  } finally {
    try {
      if (existsSync(tmpPath)) unlinkSync(tmpPath);
    } catch {
      /* best-effort */
    }
  }
}

function toPersistable(report: DeliveryContextPackReport): PersistedDeliveryContextPackArtifact {
  return {
    storyId: report.storyId,
    generatedFor: 'delivery-review',
    diff: report.diff,
    docsPromises: report.docsPromises,
    realMachineTests: report.realMachineTests,
    validation: report.validation,
    reviewRound: report.reviewRound,
    deliveryCheck: { status: report.deliveryCheck.status, ref: report.deliveryCheck.ref },
    waiver: { status: report.waiver.status },
    isSigner: false,
    claims: { authorityDone: false, fullAuthorityDone: false, productionDone: false },
  };
}

export function renderDeliveryContextPackReport(report: DeliveryContextPackReport): string {
  const lines = [
    `Delivery context pack (${report.storyId})`,
    'mode: read-only context producer (NOT a delivery signer; never writes delivery-check.json or accepts a waiver)',
    `phase: ${report.phase}`,
    '',
    `Diff vs main (${report.diff.changedFiles.length} changed file(s)):`,
  ];
  if (report.diff.changedFiles.length === 0) {
    lines.push('  (no delivery-scoped changes detected)');
  } else {
    for (const file of report.diff.changedFiles) lines.push(`  ${file}`);
    if (report.diff.summary) {
      lines.push('  summary:');
      for (const sLine of report.diff.summary.split('\n')) lines.push(`    ${sLine}`);
    }
  }

  lines.push('', `Docs-promises (${report.docsPromises.length}):`);
  if (report.docsPromises.length === 0) {
    lines.push('  (none authored in plan.md or checklist userSees)');
  } else {
    for (const p of report.docsPromises) lines.push(`  [${p.source}] ${p.promise}`);
  }

  lines.push('', 'Real-machine tests:');
  lines.push(`  transcript-diff.md present: ${report.realMachineTests.transcriptDiff}`);
  lines.push(`  test files: ${report.realMachineTests.testFiles.length === 0 ? '(none declared)' : report.realMachineTests.testFiles.join(', ')}`);
  lines.push(`  evidence commands: ${report.realMachineTests.evidenceCommands.length === 0 ? '(none recorded)' : report.realMachineTests.evidenceCommands.join(' | ')}`);

  lines.push('', 'Validation + review:');
  lines.push(`  validation: ${report.validation === null ? '(none recorded)' : JSON.stringify(report.validation)}`);
  lines.push(`  reviewRound: ${report.reviewRound ?? '(none)'}`);

  lines.push('', 'Delivery-check (consumed from V1 readiness deliveryCheckRef):');
  lines.push(`  status: ${report.deliveryCheck.status}`);
  lines.push(`  ref: ${report.deliveryCheck.ref === null ? 'null' : JSON.stringify(report.deliveryCheck.ref)}`);
  if (report.deliveryReadinessRow) {
    const r = report.deliveryReadinessRow;
    const marker = r.blocking ? 'BLOCKED' : r.status.toUpperCase();
    lines.push(`  V1 row: [${marker}] ${r.id} code=${r.code} owner=${r.owner}`);
    lines.push(`          ${r.reason}`);
  } else {
    lines.push('  V1 row: (no dedicated delivery-check row at this target)');
  }
  lines.push(`  metadata-only waiver: ${report.waiver.status}${report.waiver.ref === null ? '' : ` ${JSON.stringify(report.waiver.ref)}`} (surfaced only; the delivery reviewer accepts/rejects it)`);

  lines.push('', 'Write:');
  lines.push(`  requested: ${report.write.requested}`);
  lines.push(`  persisted: ${report.write.persisted}`);
  if (report.write.artifactPath) lines.push(`  path: ${report.write.artifactPath}`);
  if (!report.write.requested) {
    lines.push('', 'Hint: pass --write to persist this pack to <storyDir>/evidence/delivery-context-pack.json (ownership/scope gated). This command never signs the delivery check.');
  }

  lines.push('', 'Local assurance:');
  lines.push(`  isSigner: ${report.isSigner}`);
  lines.push('  admissibilityStatus: delivery-context');
  lines.push('  assuranceLevel: local');
  lines.push('  evidenceScope: delivery-review-input');
  return lines.join('\n');
}

export function createDeliveryContextPackHandlers(ctx: HandlerContext): Record<string, (...args: any[]) => any> {
  function deliveryContextPack(args: DeliveryContextPackArgs): DeliveryContextPackReport | string {
    assertBoundary(args);
    assertSafeStoryId(args.storyId);

    if (!ctx.store.storyExists(args.storyId)) {
      throw new Error(`delivery_context_pack: story ${args.storyId} not found`);
    }

    const gitCwd = resolveGitCwd({
      store: ctx.store,
      storyId: args.storyId,
      metadataRoot: ctx.root,
      projectRoot: ctx.root,
    });

    // Consume the V1 readiness reader (same reader lifecycle_check uses); never
    // re-derive the delivery-check classification or invent a new predicate.
    const readinessReport = buildStoryReadinessReport({
      storyId: args.storyId,
      target: READINESS_TARGET,
      store: ctx.store,
      root: ctx.root,
    });

    const checklist = readChecklist(ctx, args.storyId);

    const diff = deliveryScopedDiff(gitCwd);
    const docsPromises = [...planDocsPromises(ctx, args.storyId), ...userSeesDocsPromises(checklist)];
    const rmTests = realMachineTests(ctx, args.storyId, checklist);
    const deliveryRow = deliveryReadinessRow(readinessReport);
    const deliveryCheck = deliveryCheckStatus(readinessReport, deliveryRow);
    const waiverRef = readinessReport.artifacts.metadataOnlyWaiverRef;

    const artifactPath = ctx.store.storyFilePath(args.storyId, PACK_ARTIFACT);

    const report: DeliveryContextPackReport = {
      storyId: args.storyId,
      generatedFor: 'delivery-review',
      phase: readinessReport.phase,
      mode: { runCommands: false, writeEvidence: false },
      diff,
      docsPromises,
      realMachineTests: rmTests,
      validation: readinessReport.artifacts.validationRef,
      reviewRound: readinessReport.artifacts.reviewRound,
      deliveryCheck,
      waiver: { status: waiverRef === null ? 'none' : 'surfaced', ref: waiverRef },
      deliveryReadinessRow: deliveryRow,
      isSigner: false,
      write: { requested: wantsWrite(args), persisted: false, artifactPath: null },
      claims: { authorityDone: false, fullAuthorityDone: false, productionDone: false },
    };

    // --write: persist the SAME structured pack (ownership/scope gated by the CLI
    // gate). This NEVER writes delivery-check.json and NEVER signs.
    if (wantsWrite(args)) {
      persistArtifact(artifactPath, toPersistable(report));
      report.mode = { runCommands: false, writeEvidence: true };
      report.write = { requested: true, persisted: true, artifactPath };
    }

    return wantsJson(args) ? report : renderDeliveryContextPackReport(report);
  }

  return {
    delivery_context_pack: deliveryContextPack,
  };
}
