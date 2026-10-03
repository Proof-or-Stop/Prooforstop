/**
 * Compact owner-facing text for `host_run_status` (run 14 cost analysis).
 *
 * The full status record (projection + receipt + retained live-output frames)
 * is 25k-75k tokens for a real reviewer; an owner that re-reads it on every
 * later turn paid 30.2M input tokens in run 14. This summary is <= ~300 tokens
 * and keeps every fact a gate or the owner acts on: the run binding the
 * benchmark controller validates, state/stage/generation, exit, the provider
 * final-result verdict and finding count, receiptId, replacementSafe, the
 * supervision diagnostic, the next action and the full-record path. Full JSON
 * stays available with --json=true or --full=true.
 *
 * Old-PoS run 15: a completed implementer printed `failureKind=auth` (a false
 * classifier hit) and "result: no provider final result" (an implementer never
 * sends one), and the owner relaunched it. A terminal summary now leads with a
 * plain `OK:` / `FAILED:` verdict, shows failureKind only for a run that did not
 * complete, shows a code-writer's sealed output (item/finding and commit)
 * instead of a provider final result, and treats
 * managed_dispatch_target_already_done as OK (nothing to do; see the earlier run).
 *
 * Data (collectHostRunStatusSummaryFacts) is read separately from the pure
 * rendering (composeHostRunStatusSummary).
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  findSealedManagedImplementerCompletion,
  managedHostRunDirectory,
  MANAGED_DISPATCH_TARGET_ALREADY_DONE,
  readManagedHostRunResult,
  type ManagedHostRunStatusResult,
  type SealedManagedImplementerCompletion,
} from '../core/managed-host-run.js';
import { managedRunMaterialCommit } from '../core/managed-run-commit.js';
import type { HostRunResult } from '../core/host-run.js';
import { renderManagedRunDurationEstimate } from '../core/managed-run-duration-estimate.js';
import { ownerWaitInstruction } from '../core/owner-wait-guidance.js';

interface SpecView {
  cwd?: string;
  createdAt?: string;
  managedDispatchTarget?: { itemId?: string; findingId?: string } | null;
}

/** Code-writing roles: their output is a commit, never a provider final result. */
const CODE_WRITER_ROLES = new Set(['proof-or-stop-implementer', 'proof-or-stop-finding-repair']);

export interface VerdictView {
  conclusion?: unknown;
  verdict?: unknown;
  findings?: unknown;
}

function readJsonFile<T>(path: string): T | null {
  try {
    return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) as T : null;
  } catch {
    return null;
  }
}

function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

function parseVerdict(text: string | null): VerdictView | null {
  if (!text) return null;
  const trimmed = text.trim();
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const value = JSON.parse(trimmed.slice(start, end + 1)) as unknown;
    return value && typeof value === 'object' && !Array.isArray(value) ? value as VerdictView : null;
  } catch {
    return null;
  }
}

function severityCounts(findings: unknown[]): string {
  const counts = new Map<string, number>();
  for (const finding of findings) {
    const severity = finding && typeof finding === 'object' && typeof (finding as { severity?: unknown }).severity === 'string'
      ? (finding as { severity: string }).severity : 'unknown';
    counts.set(severity, (counts.get(severity) ?? 0) + 1);
  }
  return [...counts].map(([severity, count]) => `${severity}:${count}`).join(',');
}

/** Verdict line from the sealed evidence proposal, else the provider's final result. */
function resultLine(proposal: VerdictView | null, finalResult: string | null, finalCount: number, truncated: boolean): string | null {
  const verdict = proposal ?? parseVerdict(finalResult);
  const conclusion = verdict?.conclusion ?? verdict?.verdict;
  if (typeof conclusion === 'string') {
    const findings = Array.isArray(verdict!.findings) ? verdict!.findings : [];
    const source = proposal ? 'evidence-proposal' : 'final-result';
    return `result: verdict=${conclusion} findings=${findings.length}${findings.length ? ` (${severityCounts(findings)})` : ''} source=${source}`;
  }
  if (finalResult) {
    return `result: final=${JSON.stringify(oneLine(finalResult, 160))} chars=${finalResult.length} count=${finalCount}${truncated ? ' truncated=true' : ''}`;
  }
  return finalCount === 0 ? 'result: no provider final result' : null;
}

export interface HostRunStatusSummaryFacts {
  /** Full-record directory. */
  dir: string;
  target: { itemId?: string; findingId?: string } | null;
  result: Pick<HostRunResult, 'exitCode' | 'timedOut' | 'failureKind' | 'finalAssistantResult'
    | 'finalAssistantResultCount' | 'finalAssistantResultTruncated'> | null;
  proposal: VerdictView | null;
  /** Completed code-writer run: the material commit it left (null = none found in its window). */
  codeOutput: { commit: string | null } | null;
  /** managed_dispatch_target_already_done: the earlier run that sealed the item. */
  priorCompletion: SealedManagedImplementerCompletion | null;
}

function targetLabel(target: HostRunStatusSummaryFacts['target']): string {
  return target?.itemId ? `item ${target.itemId}` : target?.findingId ? `finding ${target.findingId}` : 'output';
}

function nextAction(status: ManagedHostRunStatusResult, facts: HostRunStatusSummaryFacts): string {
  const run = status.run;
  if (!run.terminal) return 'Next: run this same command again after the wait (one call per wait; do not poll more often).';
  if (run.state === 'completed' || run.terminal.reason === MANAGED_DISPATCH_TARGET_ALREADY_DONE) {
    const why = run.terminal.reason === MANAGED_DISPATCH_TARGET_ALREADY_DONE
      ? ` (${targetLabel(facts.target)} was already completed by run ${facts.priorCompletion?.runId ?? "an earlier run"}; no new run is needed)`
      : ' (it imports/consumes this terminal result)';
    return run.storyId ? `Next: proof-or-stop next --storyId=${run.storyId}${why}.` : 'Next: none (adhoc run completed).';
  }
  if (run.supervisionDiagnostic) return `Next: ${run.supervisionDiagnostic.action}`;
  return run.replacementSafe
    ? 'Next: replacementSafe=true: relaunch this role once with a fresh dispatch/ReviewRun; if that also fails, stop and report.'
    : 'Next: not replacement-safe: stop, preserve state and report this run.';
}

function verdictLine(status: ManagedHostRunStatusResult, facts: HostRunStatusSummaryFacts): string | null {
  const run = status.run;
  if (!run.terminal) return null;
  const role = run.agentType;
  if (run.terminal.reason === MANAGED_DISPATCH_TARGET_ALREADY_DONE) {
    const prior = facts.priorCompletion;
    return `OK: nothing to do: ${targetLabel(facts.target)} was already completed by run ${prior?.runId ?? '(earlier run)'}`
      + `${prior?.commit ? ` (commit ${prior.commit})` : ''}; this ${role} run changed nothing.`;
  }
  if (run.state === 'completed') {
    if (facts.codeOutput) {
      return `OK: ${role} completed ${targetLabel(facts.target)}${facts.codeOutput.commit ? ` with commit ${facts.codeOutput.commit}` : ''}.`;
    }
    return `OK: ${role} run completed.`;
  }
  return `FAILED: ${role} run ${run.state} (${run.terminal.reason}).`;
}

/** Pure rendering of the compact status from already collected facts. */
export function composeHostRunStatusSummary(status: ManagedHostRunStatusResult, facts: HostRunStatusSummaryFacts): string {
  const run = status.run;
  const { target, result } = facts;
  const lines: string[] = [];
  if (!run.terminal) lines.push(ownerWaitInstruction());
  const verdict = verdictLine(status, facts);
  if (verdict) lines.push(verdict);
  const terminal = run.terminal ? ` terminal=${run.terminal.state}:${run.terminal.reason}` : '';
  // failureKind explains a run that did not complete; on a completed run it is
  // at most a stale diagnostic and is never shown.
  const failureKind = result?.failureKind && result.failureKind !== 'none' && run.state !== 'completed'
    && run.terminal?.reason !== MANAGED_DISPATCH_TARGET_ALREADY_DONE ? ` failureKind=${result.failureKind}` : '';
  const exit = result ? ` exit=${result.exitCode}${result.timedOut ? ' timedOut=true' : ''}${failureKind}` : '';
  lines.push(`run ${run.runId} state=${run.state} stage=${run.stage.number}/${run.stage.total}:${run.stage.name} generation=${run.generation}${terminal}${exit}`);
  lines.push(`binding: story=${run.storyId ?? 'none'} phase=${run.phase} agentType=${run.agentType} host=${run.host} `
    + `model=${run.model ?? 'default'} effort=${run.reasoningEffort ?? 'default'} profile=${run.profile ?? 'none'}`
    + `${run.lane ? ` lane=${run.lane}` : ''}${run.reviewRunId ? ` reviewRunId=${run.reviewRunId}` : ''}`
    + `${target?.itemId ? ` itemId=${target.itemId}` : ''}${target?.findingId ? ` findingId=${target.findingId}` : ''}`);
  if (!run.terminal) {
    lines.push(`progress: deadlineAt=${run.deadlineAt} ${renderManagedRunDurationEstimate(run.durationEstimate)} `
      + `workerHeartbeatAt=${run.workerHeartbeatAt ?? 'none'} providerProgressMode=${run.providerProgressMode} `
      + `lastProviderProgressAt=${run.lastProviderProgressAt ?? 'none'}`);
  } else if (CODE_WRITER_ROLES.has(run.agentType)) {
    if (facts.codeOutput) {
      lines.push(`output: sealed ${targetLabel(target)} commit ${facts.codeOutput.commit ?? 'none found in the run window'}`);
    }
  } else {
    const verdictText = resultLine(facts.proposal, result?.finalAssistantResult ?? null, result?.finalAssistantResultCount ?? 0, result?.finalAssistantResultTruncated ?? false);
    if (verdictText) lines.push(verdictText);
  }
  lines.push(`receiptId=${status.receipt?.receiptId ?? 'none'} replacementSafe=${run.replacementSafe}`);
  if (run.supervisionDiagnostic) lines.push(`diagnostic: ${run.supervisionDiagnostic.code}: ${run.supervisionDiagnostic.action}`);
  if (run.managedReviewScratchCleanupDiagnostic) lines.push('diagnostic: managed-review scratch cleanup pending (see full record)');
  lines.push(nextAction(status, facts));
  lines.push(`Full record: ${facts.dir} (full JSON incl. live output: add --json=true or --full=true)`);
  return lines.join('\n');
}

/** Read the run-directory facts the compact summary needs. */
export function collectHostRunStatusSummaryFacts(root: string, status: ManagedHostRunStatusResult): HostRunStatusSummaryFacts {
  const run = status.run;
  const dir = managedHostRunDirectory(root, run.runId);
  const spec = readJsonFile<SpecView>(join(dir, 'spec.json'));
  const target = spec?.managedDispatchTarget ?? null;
  const result = run.terminal ? readManagedHostRunResult(root, run.runId) : null;
  const codeWriter = CODE_WRITER_ROLES.has(run.agentType);
  const codeOutput = run.terminal && run.state === 'completed' && codeWriter
    ? { commit: spec?.cwd && spec.createdAt && existsSync(spec.cwd)
      ? managedRunMaterialCommit({ root, gitCwd: spec.cwd, createdAt: spec.createdAt, terminalAt: run.terminal.terminalAt })
      : null }
    : null;
  const priorCompletion = run.terminal?.reason === MANAGED_DISPATCH_TARGET_ALREADY_DONE && run.storyId && target?.itemId
    ? findSealedManagedImplementerCompletion({ root, storyId: run.storyId, itemId: target.itemId, excludeRunId: run.runId })
    : null;
  return {
    dir, target, result, codeOutput, priorCompletion,
    proposal: run.terminal && !codeWriter ? readJsonFile<VerdictView>(join(dir, 'evidence-proposal.json')) : null,
  };
}

/**
 * Render the compact summary. A non-terminal status leads with the wait
 * instruction so a returning wait call re-arms the long yield; a terminal one
 * leads with a plain OK:/FAILED: verdict.
 */
export function renderHostRunStatusSummary(root: string, status: ManagedHostRunStatusResult): string {
  return composeHostRunStatusSummary(status, collectHostRunStatusSummaryFacts(root, status));
}
