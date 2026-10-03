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
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  managedHostRunDirectory,
  readManagedHostRunResult,
  type ManagedHostRunStatusResult,
} from '../core/managed-host-run.js';
import { renderManagedRunDurationEstimate } from '../core/managed-run-duration-estimate.js';
import { ownerWaitInstruction } from '../core/owner-wait-guidance.js';

interface SpecView {
  cwd?: string;
  managedDispatchTarget?: { itemId?: string; findingId?: string } | null;
}

interface VerdictView {
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
function resultLine(dir: string, finalResult: string | null, finalCount: number, truncated: boolean): string | null {
  const proposal = readJsonFile<VerdictView>(join(dir, 'evidence-proposal.json'));
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

function commitLine(cwd: string | undefined): string | null {
  if (!cwd || !existsSync(cwd)) return null;
  const head = spawnSync('git', ['-C', cwd, 'log', '-1', '--format=%h %s'], { encoding: 'utf8', timeout: 5_000 });
  return head.status === 0 && head.stdout.trim() ? `commit: ${oneLine(head.stdout, 120)}` : null;
}

function nextAction(status: ManagedHostRunStatusResult): string {
  const run = status.run;
  if (!run.terminal) return 'Next: run this same command again after the wait (one call per wait; do not poll more often).';
  if (run.state === 'completed') {
    return run.storyId
      ? `Next: proof-or-stop next --storyId=${run.storyId} (it imports/consumes this terminal result).`
      : 'Next: none (adhoc run completed).';
  }
  if (run.supervisionDiagnostic) return `Next: ${run.supervisionDiagnostic.action}`;
  return run.replacementSafe
    ? 'Next: replacementSafe=true: relaunch this role once with a fresh dispatch/ReviewRun; if that also fails, stop and report.'
    : 'Next: not replacement-safe: stop, preserve state and report this run.';
}

/**
 * Render the compact summary. A non-terminal status leads with the wait
 * instruction so a returning wait call re-arms the long yield.
 */
export function renderHostRunStatusSummary(root: string, status: ManagedHostRunStatusResult): string {
  const run = status.run;
  const dir = managedHostRunDirectory(root, run.runId);
  const spec = readJsonFile<SpecView>(join(dir, 'spec.json'));
  const target = spec?.managedDispatchTarget;
  const lines: string[] = [];
  if (!run.terminal) lines.push(ownerWaitInstruction());
  const terminal = run.terminal ? ` terminal=${run.terminal.state}:${run.terminal.reason}` : '';
  const result = run.terminal ? readManagedHostRunResult(root, run.runId) : null;
  const exit = result ? ` exit=${result.exitCode}${result.timedOut ? ' timedOut=true' : ''}${result.failureKind ? ` failureKind=${result.failureKind}` : ''}` : '';
  lines.push(`run ${run.runId} state=${run.state} stage=${run.stage.number}/${run.stage.total}:${run.stage.name} generation=${run.generation}${terminal}${exit}`);
  lines.push(`binding: story=${run.storyId ?? 'none'} phase=${run.phase} agentType=${run.agentType} host=${run.host} `
    + `model=${run.model ?? 'default'} effort=${run.reasoningEffort ?? 'default'} profile=${run.profile ?? 'none'}`
    + `${run.lane ? ` lane=${run.lane}` : ''}${run.reviewRunId ? ` reviewRunId=${run.reviewRunId}` : ''}`
    + `${target?.itemId ? ` itemId=${target.itemId}` : ''}${target?.findingId ? ` findingId=${target.findingId}` : ''}`);
  if (!run.terminal) {
    lines.push(`progress: deadlineAt=${run.deadlineAt} ${renderManagedRunDurationEstimate(run.durationEstimate)} `
      + `workerHeartbeatAt=${run.workerHeartbeatAt ?? 'none'} providerProgressMode=${run.providerProgressMode} `
      + `lastProviderProgressAt=${run.lastProviderProgressAt ?? 'none'}`);
  } else {
    const verdict = resultLine(dir, result?.finalAssistantResult ?? null, result?.finalAssistantResultCount ?? 0, result?.finalAssistantResultTruncated ?? false);
    if (verdict) lines.push(verdict);
    if (target?.itemId || target?.findingId) {
      const commit = commitLine(spec?.cwd);
      if (commit) lines.push(commit);
    }
  }
  lines.push(`receiptId=${status.receipt?.receiptId ?? 'none'} replacementSafe=${run.replacementSafe}`);
  if (run.supervisionDiagnostic) lines.push(`diagnostic: ${run.supervisionDiagnostic.code}: ${run.supervisionDiagnostic.action}`);
  if (run.managedReviewScratchCleanupDiagnostic) lines.push('diagnostic: managed-review scratch cleanup pending (see full record)');
  lines.push(nextAction(status));
  lines.push(`Full record: ${dir} (full JSON incl. live output: add --json=true or --full=true)`);
  return lines.join('\n');
}
