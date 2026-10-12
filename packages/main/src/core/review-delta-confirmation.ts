/**
 * EXPERIMENTAL A/B review.deltaRounds=on (core/review-delta-round.ts): the
 * import-time check of a delta round's ONE confirmation lane (ADR-054 of the
 * new PoS: never pass what was not checked).
 *
 * The sealed run binding (reviewBinding.deltaRound) names the check items and
 * the findings resolved in the previous remediation. The lane's note must carry
 * a `[checked]` line per item (a `file:` item must also be in its read
 * manifest) and a `[reverified] <finding> :: <command> :: <output line>` line
 * per resolved finding. The framework re-runs each named command in the Story
 * worktree (the duplicate-coverage runner: one allowlisted executable, project
 * validate.env, exit 0 and the output line required). Anything missing, a
 * `[gap]` on a check item or resolved finding, or a failing re-run makes the
 * result a GAP: a pass is then not imported, the gap is recorded, and the
 * round falls back to a full round.
 *
 * Old-PoS run 52 (bench-staging/oldpos/run52-analysis.md §3 D1): the note of a
 * FINDINGS verdict is kept in its proposal (it was dropped, so 3 of 3
 * findings-verdict confirmation lanes gapped), and its [reverified] commands
 * are re-run too (a broken repair is still caught). A findings verdict with a
 * gap imports its findings without a late lane in its own round; the next
 * round is a full round (core/review-delta-round.ts PREVIOUS_CONFIRMATION_GAP).
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
  // Old-PoS run 52: a findings verdict's re-verifications are re-run as well; a failure is recorded as its gap.
  {
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
