/**
 * Old-PoS run 34 (bench-staging/oldpos/run34-analysis.md F3, §4 sink 4):
 * story_create was refused twice at INIT on its verificationIntent rows, one
 * problem tier at a time, and each time the owner re-emitted the whole payload
 * (17.0k, 14.0k and 15.2k output tokens, carried in its context for the rest of
 * the run). The intake checks are unchanged (classification, derivation); a
 * refusal now
 *   - lists every refused row of every item at once,
 *   - stages the submitted payload in a runtime file, and
 *   - names ONE next action: patch the listed rows in that file, then
 *     `proof-or-stop story_create @<file>` (the CLI reads `@<file.json>` as the payload).
 * Nothing is written to the Story store on a refusal.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { VerificationIntent } from './types.js';
import { describeDerivationProblem, INTENT_DERIVATION_REQUIRED, intentDerivationRows } from './intent-derivation.js';

/** The staged payload of the last refused story_create (runtime, one per project). */
export function storyCreateStagedPayloadPath(mainRoot: string): string {
  return join(mainRoot, '.proof-or-stop', 'runtime', 'story-create', 'payload.json');
}

/** Stage the submitted payload; returns its path (null when it cannot be written). */
export function stageStoryCreatePayload(mainRoot: string, payload: Record<string, unknown>): string | null {
  const path = storyCreateStagedPayloadPath(mainRoot);
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(Object.fromEntries(Object.entries(payload).filter(([, value]) => value !== undefined)), null, 2)}\n`);
    return path;
  } catch { return null; }
}

/** Every underived example row of every item (the same rule as intentDerivationFailure), or null. */
export function storyCreateDerivationFailure(items: ReadonlyArray<{ itemId: string; verificationIntent: VerificationIntent | undefined }>, requestText: string | null): string | null {
  if (requestText === null) return null;
  const bad = items.flatMap(item => intentDerivationRows(item.itemId, item.verificationIntent, requestText).filter(row => row.problem !== null));
  if (!bad.length) return null;
  return `story_create REFUSED, nothing was written: an example whose expected value is not quoted verbatim from request.md must carry a derivation [${INTENT_DERIVATION_REQUIRED}]\n`
    + `${bad.map(row => describeDerivationProblem(row, requestText)).join('\n')}\n`
    + 'Add to each row: "derivation":{"requestQuote":"<verbatim request.md sentence the value follows from>","computation":"<steps from that sentence to the pinned value, ending at that value>"}. '
    + 'If the computation reaches a different value, the pinned value is wrong: fix it.';
}

/** One refusal from every intake failure: their rows, then ONE Next naming the staged payload. */
export function renderStoryCreateIntakeRefusal(failures: readonly string[], stagedPath: string | null): string {
  const body = failures.map(text => text.split('\n').filter(line => !/^Next:/.test(line.trim())).join('\n').trim()).join('\n\n');
  const next = stagedPath
    ? `Next: fix only the rows listed above in ${stagedPath} (the payload you submitted, staged; edit those fields, do not re-send the whole payload), then run: proof-or-stop story_create @${stagedPath}`
    : 'Next: rerun story_create with the listed rows fixed (no Story was created).';
  return `${body}\n${next}`;
}

/**
 * Old-PoS run 40 (N4): a story_create refused by argument validation (a row
 * `type` outside the enum, 12 rows) was not staged, so the owner re-sent the
 * whole payload (7.2k output tokens). The same staged path and ONE Next as an
 * intake refusal; the validation issues stay the refusal body.
 */
export function storyCreateSchemaRefusalNext(stagedPath: string | null): string | null {
  return stagedPath
    ? `fix only the fields listed above in ${stagedPath} (the payload you submitted, staged; edit those fields, do not re-send the whole payload), then run: proof-or-stop story_create @${stagedPath}`
    : null;
}
