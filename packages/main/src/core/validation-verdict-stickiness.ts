/**
 * Fail-sticky verdicts.
 *
 * A validation identity is the command set, the committed material, the story
 * files and the compiled artifacts a run executed. When an EXECUTED run on one
 * identity failed, a PASS on the same identity is not fresh evidence: nothing
 * changed and the verdict changed. The failure stands until the material or the
 * build changes, whichever way round the two runs happened. This is the rule the
 * measured history asked for: 23 of 57 re-validated identities flipped fail to
 * pass with nothing changed, all in the passing direction.
 *
 * What does not stick: an infrastructure failure (a timeout, a refused launch,
 * a persistence failure) is not a verdict about the code; a reused terminal
 * executed nothing; and a legacy terminal without the compiled-artifact
 * identity cannot be matched to anything and is left alone rather than guessed.
 * A failure that recorded no failure kind at all is treated as a verdict, so a
 * producer that forgets the kind fails closed rather than open.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface ValidationVerdictIdentity {
  commandSetHash: string;
  materialHash: string;
  storyFilesHash: string;
  buildArtifactsHash: string;
}

/** The subset of a `validation_terminal` process event this rule reads; every field is untrusted input. */
export interface ValidationTerminalFact {
  type?: unknown;
  result?: unknown;
  disposition?: unknown;
  failureKind?: unknown;
  commandSetHash?: unknown;
  materialHash?: unknown;
  storyFilesHash?: unknown;
  buildArtifactsHash?: unknown;
  timestamp?: unknown;
}

export const VERDICT_FLIP_REUSE_REASON = 'verdict-flip-unattested';
export const VERDICT_FLIP_ADMISSION_CODE = 'verdict_flip_unattested';

const isSha256 = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

/** The full identity of a piece of evidence, or null when any part is missing (legacy evidence is never matched). */
export function validationVerdictIdentity(evidence: {
  routineValidationIdentity?: { digest?: unknown } | null;
  materialHash?: unknown;
  storyFilesHash?: unknown;
  buildArtifactsHash?: unknown;
} | null | undefined): ValidationVerdictIdentity | null {
  const commandSetHash = evidence?.routineValidationIdentity?.digest;
  if (!evidence || !isSha256(commandSetHash) || !isSha256(evidence.materialHash) || !isSha256(evidence.storyFilesHash) || !isSha256(evidence.buildArtifactsHash)) return null;
  return { commandSetHash, materialHash: evidence.materialHash, storyFilesHash: evidence.storyFilesHash, buildArtifactsHash: evidence.buildArtifactsHash };
}

/** Executed validation failures recorded on exactly this identity; order is irrelevant. */
export function stickyFailuresFor(identity: ValidationVerdictIdentity, terminals: readonly ValidationTerminalFact[]): ValidationTerminalFact[] {
  return terminals.filter((terminal) => terminal.type === 'validation_terminal'
    && terminal.result === 'fail'
    && terminal.disposition === 'executed'
    && terminal.failureKind !== 'infra_failure'
    && terminal.commandSetHash === identity.commandSetHash
    && terminal.materialHash === identity.materialHash
    && terminal.storyFilesHash === identity.storyFilesHash
    && terminal.buildArtifactsHash === identity.buildArtifactsHash);
}

/** Human-readable refusal for a flipped verdict, naming what would legitimately release it. */
export function describeStickyFailure(identity: ValidationVerdictIdentity, failures: readonly ValidationTerminalFact[]): string {
  const when = failures.map((failure) => (typeof failure.timestamp === 'string' ? failure.timestamp : 'unknown time')).join(', ');
  return `an executed validation run failed on this exact identity (command set ${identity.commandSetHash.slice(0, 12)}, material ${identity.materialHash.slice(0, 12)}, compiled artifacts ${identity.buildArtifactsHash.slice(0, 12)}) at ${when}; `
    + 'a PASS with nothing changed is a flipped verdict, not fresh evidence. The failure stands until the material or the build changes.';
}

/** A Story's validation history: its terminals, or the reason it could not be read. */
export type ValidationHistory = { terminals: ValidationTerminalFact[] } | { unreadable: string };

export const HISTORY_UNREADABLE_REUSE_REASON = 'validation-history-unreadable';
export const HISTORY_UNREADABLE_ADMISSION_CODE = 'validation_history_unreadable';

/**
 * Read a Story's validation terminals from its process-events file. A Story
 * that has no file yet has an empty history; a file that cannot be read, or
 * that holds a line that is not a JSON object, is UNREADABLE and is reported
 * as such, never as empty: an empty history would prove that no failure
 * exists, and an unreadable one proves nothing.
 */
export function readValidationHistory(store: { storyDirPath(storyId: string): string }, storyId: string): ValidationHistory {
  let path: string;
  try { path = join(store.storyDirPath(storyId), 'process-events.jsonl'); } catch (error) { return { unreadable: `story directory unavailable: ${error instanceof Error ? error.message : String(error)}` }; }
  if (!existsSync(path)) return { terminals: [] };
  let content: string;
  try { content = readFileSync(path, 'utf8'); } catch (error) { return { unreadable: `${path}: ${error instanceof Error ? error.message : String(error)}` }; }
  const terminals: ValidationTerminalFact[] = [];
  const lines = content.split('\n');
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index].trim();
    if (!line) continue;
    let event: unknown;
    try { event = JSON.parse(line); } catch { return { unreadable: `${path}: line ${index + 1} is not valid JSON` }; }
    if (!event || typeof event !== 'object' || Array.isArray(event)) return { unreadable: `${path}: line ${index + 1} is not a process event` };
    if ((event as ValidationTerminalFact).type === 'validation_terminal') terminals.push(event as ValidationTerminalFact);
  }
  return { terminals };
}
