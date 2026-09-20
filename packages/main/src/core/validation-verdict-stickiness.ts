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

/** Read a Story's validation terminals from any store that exposes its process events; a store that cannot be read yields none. */
export function readValidationTerminals(store: { readProcessEvents(storyId: string): unknown[] }, storyId: string): ValidationTerminalFact[] {
  try {
    return (store.readProcessEvents(storyId) as ValidationTerminalFact[]).filter((event) => event && event.type === 'validation_terminal');
  } catch {
    return [];
  }
}
