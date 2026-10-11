/**
 * EXPERIMENTAL A/B review.deltaRounds=on (core/review-delta-round.ts): the
 * import-time check of a delta round's ONE confirmation lane (ADR-054 of the
 * new PoS: never pass what was not checked).
 *
 * The sealed run binding (reviewBinding.deltaRound) names the check items and
 * the findings resolved in the previous remediation. The lane's note must carry
 * a `[checked]` line per item (a `file:` item must also be in its read
 * manifest) and a `[reverified] <finding> :: <command> :: <output line>` line
 * per resolved finding. For a pass the framework re-runs each named command in
 * the Story worktree (the duplicate-coverage runner: one allowlisted executable,
 * project validate.env, exit 0 and the output line required). Anything missing,
 * any `[gap]`, or a failing re-run makes the result a GAP: a pass is then not
 * imported, the gap is recorded, and the round falls back to a full round.
 */
import { checkDeltaConfirmationNote, type DeltaRoundRunBinding } from './review-delta-round.js';
import { runDuplicateCoverage } from './duplicate-finding-coverage.js';

export interface DeltaReverifyReceipt {
  findingId: string;
  command: string;
  selector: string;
  passed: boolean;
  exitCode: number | null;
  timedOut: boolean;
  selectorMatched: boolean;
  outputTail: string;
  headHash: string | null;
  durationMs: number;
}

export interface DeltaConfirmationVerdict {
  /** True when the lane checked every item and every re-run passed. */
  ok: boolean;
  missing: string[];
  gaps: string[];
  problems: string[];
  reverified: DeltaReverifyReceipt[];
  /** One line naming everything that makes this a gap (empty when ok). */
  reason: string;
}

export function evaluateDeltaConfirmation(args: {
  binding: Pick<DeltaRoundRunBinding, 'checkItems' | 'reverifyFindingIds'>;
  storyId: string;
  conclusion: 'pass' | 'findings';
  note: string;
  readManifest?: { filesReadFully?: readonly string[]; filesTriagedByName?: readonly string[] } | null;
  projectRoot: string;
  /** The Story worktree the re-runs execute in. */
  cwd: string;
  headHash: string | null;
}): DeltaConfirmationVerdict {
  const note = checkDeltaConfirmationNote({ binding: args.binding, storyId: args.storyId, note: args.note, readManifest: args.readManifest });
  const reverified: DeltaReverifyReceipt[] = [];
  const failures: string[] = [];
  // A findings verdict sends the Story to remediation anyway; only a pass is re-run.
  if (args.conclusion === 'pass') {
    for (const row of note.reverify) {
      try {
        const run = runDuplicateCoverage({ projectRoot: args.projectRoot, cwd: args.cwd, command: row.command, selector: row.selector,
          headHash: args.headHash, findingId: row.findingId, canonicalFindingId: row.findingId });
        reverified.push({ findingId: row.findingId, command: row.command, selector: row.selector, passed: run.passed, exitCode: run.exitCode,
          timedOut: run.timedOut, selectorMatched: run.selectorMatched, outputTail: run.outputTail, headHash: run.headHash, durationMs: run.durationMs });
        if (!run.passed) failures.push(`re-run of ${row.findingId} failed (${run.timedOut ? 'timed out' : `exit ${run.exitCode}`}${run.selectorMatched ? '' : `, "${row.selector}" not printed`}): ${row.command}`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        reverified.push({ findingId: row.findingId, command: row.command, selector: row.selector, passed: false, exitCode: null,
          timedOut: false, selectorMatched: false, outputTail: message.slice(0, 600), headHash: args.headHash, durationMs: 0 });
        failures.push(`re-run of ${row.findingId} refused: ${message.slice(0, 200)}`);
      }
    }
  }
  const parts = [
    ...(note.missing.length ? [`unchecked item(s): ${note.missing.join(', ')}`] : []),
    ...(note.gaps.length ? [`[gap] ${note.gaps.join('; [gap] ')}`] : []),
    ...note.problems,
    ...failures,
  ];
  return { ok: parts.length === 0, missing: note.missing, gaps: note.gaps, problems: [...note.problems, ...failures], reverified, reason: parts.join('; ') };
}
