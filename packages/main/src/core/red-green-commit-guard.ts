/**
 * RED-before-GREEN commit-order guard (B-dc2e CHK-003).
 *
 * A PURE function over an oldest-first list of commit {subject, body} pairs. It
 * performs no git I/O: the caller (a smoke, a gate) reads `git log` and feeds
 * the list, so the same rule can be reused by any suite.
 *
 * Subjects that participate, everything else is ignored:
 *
 *   RED(CHK-nnn): ...     GREEN(CHK-nnn): ...     checklist item work
 *   RED(F-nnn): ...       GREEN(F-nnn): ...       finding-fix work
 *
 * An optional story qualifier is accepted in front of the id, as the repository
 * history already writes it: `RED(B-a745:F-016): ...`. The id is reported as
 * written inside the parentheses, so `B-a745:F-016` and `F-016` are distinct.
 *
 * Rule: every GREEN(id) must be preceded (anywhere earlier in the list, not
 * necessarily adjacently) by a RED(id). Only subjects count: a RED subject
 * that survives squashing as a body line is NOT a RED commit.
 *
 * The one exception is the documented no-RED marker. A GREEN with no earlier
 * RED is accepted only when its BODY carries a line of the form
 *
 *   No-RED: <reason>
 *
 * where `<reason>` (the rest of that line, trimmed) is at least
 * NO_RED_MIN_REASON_LENGTH (30) characters. This is for fixes that legitimately
 * have no failing fixture, such as a comment-only wording fix or a
 * registration-only change, and the reason must say why no fixture can fail.
 * The marker name is case-sensitive and must start its line; a marker with an
 * empty or too-short reason is a violation, never a silent pass.
 */

export const NO_RED_MARKER = 'No-RED:';
export const NO_RED_MIN_REASON_LENGTH = 30;

const RED_GREEN_SUBJECT = /^(RED|GREEN)\(((?:B-[0-9a-f]{4}:)?(?:CHK|F)-\d{3})\):/;
const NO_RED_LINE = /^No-RED:(.*)$/m;

export type RedGreenPhase = 'RED' | 'GREEN';

export interface RedGreenCommitInput {
  readonly subject: string;
  readonly body?: string;
}

export interface RedGreenParsedSubject {
  readonly phase: RedGreenPhase;
  /** The id exactly as written inside the parentheses, e.g. `CHK-003`, `F-007`, `B-a745:F-016`. */
  readonly id: string;
  readonly kind: 'checklist' | 'finding';
}

export interface NoRedMarker {
  /** The trimmed text after `No-RED:` on the marker line. */
  readonly reason: string;
  readonly sufficient: boolean;
}

export type RedGreenViolationCode =
  | 'green_without_red'
  | 'no_red_marker_missing_reason'
  | 'no_red_marker_reason_too_short';

export interface RedGreenViolation {
  /** Position in the oldest-first input list. */
  readonly index: number;
  readonly id: string;
  readonly subject: string;
  readonly code: RedGreenViolationCode;
  readonly detail: string;
}

export interface RedGreenNoRedAcceptance {
  readonly index: number;
  readonly id: string;
  readonly reason: string;
}

export interface RedGreenGuardResult {
  readonly ok: boolean;
  /** Every id seen in a RED or GREEN subject, first-seen order. */
  readonly ids: readonly string[];
  readonly redCount: number;
  readonly greenCount: number;
  readonly violations: readonly RedGreenViolation[];
  /** Distinct violating ids, first-seen order. */
  readonly violatingIds: readonly string[];
  /** GREEN commits accepted on the strength of a reasoned no-RED marker. */
  readonly noRedAccepted: readonly RedGreenNoRedAcceptance[];
}

/** Parse a commit subject; null when it is not a RED/GREEN subject of a recognised form. */
export function parseRedGreenSubject(subject: string): RedGreenParsedSubject | null {
  const match = RED_GREEN_SUBJECT.exec(subject);
  if (!match) return null;
  const id = match[2]!;
  return {
    phase: match[1] as RedGreenPhase,
    id,
    kind: /(?:^|:)CHK-/.test(id) ? 'checklist' : 'finding',
  };
}

/** Find the first `No-RED: <reason>` line in a commit body; null when absent. */
export function parseNoRedMarker(body: string | undefined): NoRedMarker | null {
  if (!body) return null;
  const match = NO_RED_LINE.exec(body);
  if (!match) return null;
  const reason = (match[1] ?? '').trim();
  return { reason, sufficient: reason.length >= NO_RED_MIN_REASON_LENGTH };
}

/**
 * Evaluate RED-before-GREEN ordering over commits listed OLDEST FIRST.
 * Pure: no I/O, no clock, deterministic for the same input.
 */
export function evaluateRedGreenCommitOrder(commits: readonly RedGreenCommitInput[]): RedGreenGuardResult {
  const ids: string[] = [];
  const seenRed = new Set<string>();
  const violations: RedGreenViolation[] = [];
  const noRedAccepted: RedGreenNoRedAcceptance[] = [];
  let redCount = 0;
  let greenCount = 0;

  commits.forEach((commit, index) => {
    const parsed = parseRedGreenSubject(commit.subject);
    if (!parsed) return;
    if (!ids.includes(parsed.id)) ids.push(parsed.id);

    if (parsed.phase === 'RED') {
      redCount += 1;
      seenRed.add(parsed.id);
      return;
    }

    greenCount += 1;
    if (seenRed.has(parsed.id)) return;

    const marker = parseNoRedMarker(commit.body);
    if (!marker) {
      violations.push({
        index,
        id: parsed.id,
        subject: commit.subject,
        code: 'green_without_red',
        detail: `GREEN(${parsed.id}) at #${index} has no earlier RED(${parsed.id}) and no \`${NO_RED_MARKER} <reason>\` body line; `
          + 'squashing the RED into the GREEN is what this guard forbids',
      });
      return;
    }
    if (marker.reason.length === 0) {
      violations.push({
        index,
        id: parsed.id,
        subject: commit.subject,
        code: 'no_red_marker_missing_reason',
        detail: `GREEN(${parsed.id}) at #${index} carries \`${NO_RED_MARKER}\` with no reason; `
          + `state why no fixture can fail (>= ${NO_RED_MIN_REASON_LENGTH} characters)`,
      });
      return;
    }
    if (!marker.sufficient) {
      violations.push({
        index,
        id: parsed.id,
        subject: commit.subject,
        code: 'no_red_marker_reason_too_short',
        detail: `GREEN(${parsed.id}) at #${index} carries a \`${NO_RED_MARKER}\` reason of ${marker.reason.length} characters; `
          + `at least ${NO_RED_MIN_REASON_LENGTH} are required`,
      });
      return;
    }
    noRedAccepted.push({ index, id: parsed.id, reason: marker.reason });
  });

  const violatingIds: string[] = [];
  for (const violation of violations) {
    if (!violatingIds.includes(violation.id)) violatingIds.push(violation.id);
  }

  return {
    ok: violations.length === 0,
    ids,
    redCount,
    greenCount,
    violations,
    violatingIds,
    noRedAccepted,
  };
}

/** One bounded line naming every violating id, or a pass summary. */
export function describeRedGreenViolations(result: RedGreenGuardResult): string {
  if (result.ok) {
    return `RED-before-GREEN ok: ${result.greenCount} GREEN, ${result.redCount} RED, `
      + `${result.noRedAccepted.length} reasoned no-RED across ${result.ids.length} id(s)`;
  }
  const details = result.violations.map((violation) => `${violation.id} [${violation.code}] ${violation.detail}`);
  return `RED-before-GREEN violated for ${result.violatingIds.join(', ')}: ${details.join(' | ')}`;
}
