/**
 * evidence-pin-guard.ts — PreToolUse evidence-pin seatbelt core (pure logic, no I/O).
 *
 * B-1507 CHK-003. A FAIL-OPEN seatbelt that inspects a shell command string
 * BEFORE it runs and, when it recognizes a `proof-or-stop verification_evidence_add`
 * (or `verification_run`) invocation whose caller-authored `--command` /
 * `--selector` would NOT match the intent's already-pinned immutable
 * verification (B-ec67 `VerificationIntentPin`), returns a `deny` verdict with a
 * teaching reason so the write is blocked early with a helpful message.
 *
 * This is a SEATBELT, not the enforcement floor. The real floor is
 * `enforceAndStampEvidence` in handlers/checklist.ts, which refuses the same
 * mismatch even when this hook is bypassed. Because the floor exists, the guard
 * is deliberately conservative: it denies ONLY on an explicit provided-value
 * mismatch against an existing pin, and allows (no-decision) in every ambiguous
 * case (unparseable command, missing storyId/intentRef, no pin yet, etc.).
 *
 * No I/O in this file. The handler wires the store reads (checklist load) and
 * calls the pure resolver + verdict functions here.
 */

import type { ChecklistData, VerificationIntentPin } from './types.js';
import {
  collectVerificationIntents,
  renderVerificationPinNarrowCommand,
  VERIFICATION_PIN_NARROW_COMMAND,
  VERIFICATION_PIN_NARROWING_PRECONDITION,
} from './verification.js';

// ── Verdict ──

/**
 * B-1482: the one audited movement an evidence pin admits. Named here so the teaching
 * message cannot keep offering a two-option Fix list after the third option shipped.
 * The command name and its runnable form both come from ONE place (core/verification),
 * shared with the enforcement floor, so the two messages cannot drift apart.
 */
const NARROWING_COMMAND = VERIFICATION_PIN_NARROW_COMMAND;

export type EvidencePinVerdict = 'allow' | 'deny';

/** The two evidence-write entrypoints this guard recognizes. */
export type EvidenceCommandKind = 'verification_evidence_add' | 'verification_run';

export interface ParsedEvidenceInvocation {
  /** Which evidence-write command the shell string invokes. */
  kind: EvidenceCommandKind;
  storyId?: string;
  intentRef?: string;
  /** Caller-authored command (only meaningful for verification_evidence_add). */
  callerCommand?: string;
  /** Caller-authored selector (only meaningful for verification_evidence_add). */
  callerSelector?: string;
}

export interface EvidencePinGuardResult {
  verdict: EvidencePinVerdict;
  /** True when the command string was recognized as an evidence-write invocation. */
  matched: boolean;
  storyId?: string;
  intentRef?: string;
  /** Human-readable reasons for the verdict (teaching message on deny). */
  reasons: string[];
}

// ── Command-string parsing (pure) ──

/**
 * A shell command is only considered when it looks like a ProofOrStop CLI call —
 * this keeps the guard from matching unrelated shell text that merely mentions
 * the subcommand token (e.g. `echo verification_evidence_add`).
 */
function hasProofOrStopMarker(commandString: string): boolean {
  return /(?:^|[\s"'/=])(?:proofOrStop(?:\.js)?|cli\.js)(?:[\s"']|$)/.test(commandString);
}

/** Extract the first balanced-looking JSON object argument, if present. */
function extractJsonBlob(commandString: string): Record<string, unknown> | null {
  const first = commandString.indexOf('{');
  const last = commandString.lastIndexOf('}');
  if (first === -1 || last === -1 || last <= first) return null;
  const candidate = commandString.slice(first, last + 1);
  try {
    const parsed = JSON.parse(candidate) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // PROBE: a non-JSON brace run means there is no structured arg blob to read.
  }
  return null;
}

/** Extract a `--key=value` or `--key value` flag (value may be single/double quoted). */
function extractFlag(commandString: string, key: string): string | undefined {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // --key=value  (=value may be "quoted", 'quoted', or bare)
  const eq = new RegExp(`--${escaped}=(?:"([^"]*)"|'([^']*)'|(\\S+))`);
  const m = eq.exec(commandString);
  if (m) return m[1] ?? m[2] ?? m[3];
  // --key value  (space-separated; bare token must not itself be another --flag)
  const sp = new RegExp(`--${escaped}\\s+(?:"([^"]*)"|'([^']*)'|([^\\s-][^\\s]*))`);
  const m2 = sp.exec(commandString);
  if (m2) return m2[1] ?? m2[2] ?? m2[3];
  return undefined;
}

function pickString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * Parse a shell command string into a recognized evidence-write invocation, or
 * null when the string is not a ProofOrStop evidence-write command. Handles both the
 * JSON-blob arg form (`proof-or-stop verification_evidence_add '{"storyId":...}'`) and
 * the `--key=value` / `--key value` flag form.
 */
export function parseEvidenceCommand(commandString: string): ParsedEvidenceInvocation | null {
  if (typeof commandString !== 'string' || commandString.trim().length === 0) return null;
  if (!hasProofOrStopMarker(commandString)) return null;

  const hasAdd = /(?:^|[\s"'/=])verification_evidence_add(?:[\s"']|$)/.test(commandString);
  const hasRun = /(?:^|[\s"'/=])verification_run(?:[\s"']|$)/.test(commandString);
  if (!hasAdd && !hasRun) return null;
  // verification_evidence_add is the mismatch-bearing path; prefer it when both tokens somehow appear.
  const kind: EvidenceCommandKind = hasAdd ? 'verification_evidence_add' : 'verification_run';

  const blob = extractJsonBlob(commandString);
  const storyId = pickString(blob?.storyId) ?? extractFlag(commandString, 'storyId');
  const intentRef = pickString(blob?.intentRef) ?? extractFlag(commandString, 'intentRef');
  const callerCommand = pickString(blob?.command) ?? extractFlag(commandString, 'command');
  const callerSelector = pickString(blob?.selector) ?? extractFlag(commandString, 'selector');

  return {
    kind,
    ...(storyId !== undefined ? { storyId } : {}),
    ...(intentRef !== undefined ? { intentRef } : {}),
    ...(callerCommand !== undefined ? { callerCommand } : {}),
    ...(callerSelector !== undefined ? { callerSelector } : {}),
  };
}

// ── Pin resolution (pure — operates on an already-loaded checklist) ──

/**
 * Resolve the immutable verification pin for an intentRef from an already-loaded
 * ChecklistData. Returns null when the ref does not resolve, or when the intent
 * exists but has not been pinned yet (no first selector-bearing write yet).
 */
export function resolvePinFromChecklist(
  checklist: ChecklistData,
  intentRef: string,
): VerificationIntentPin | null {
  if (!checklist || !Array.isArray(checklist.items)) return null;
  for (const item of checklist.items) {
    for (const collected of collectVerificationIntents(item)) {
      if (collected.ref === intentRef) {
        return collected.intent.verification ?? null;
      }
    }
  }
  return null;
}

/**
 * Resolve WHICH checklist item owns `intentRef`. B-1482 F-008: the taught narrowing
 * command needs `--itemId`, and a custom intent id encodes no item, so the owner is
 * resolved from the same loaded checklist the pin came from instead of being guessed.
 */
export function resolveIntentOwnerItemId(
  checklist: ChecklistData,
  intentRef: string,
): string | undefined {
  if (!checklist || !Array.isArray(checklist.items)) return undefined;
  for (const item of checklist.items) {
    for (const collected of collectVerificationIntents(item)) {
      if (collected.ref === intentRef) return item.id;
    }
  }
  return undefined;
}

// ── Verdict computation (pure) ──

/**
 * Compute the evidence-pin verdict from a parsed invocation and the resolved pin
 * (or null). Conservative by design:
 *   - verification_run          → allow (the command comes from the pin; the
 *                                  caller cannot author a mismatch).
 *   - add, no pin yet           → allow (the first write will pin it).
 *   - add, pin exists, provided command/selector differ → DENY + teaching reason.
 *   - add, pin exists, values match or absent → allow.
 */
export function computeEvidencePinVerdict(
  parsed: ParsedEvidenceInvocation,
  pin: VerificationIntentPin | null,
  /**
   * B-1482 F-008: the checklist item that owns the intent, when the caller resolving the
   * pin also resolved the owner. Used only to fill `--itemId` into the taught narrowing
   * form; absent, the form falls back to the ref-derived item or a `<placeholder>`.
   */
  owner?: { itemId?: string },
): EvidencePinGuardResult {
  const base = {
    matched: true,
    ...(parsed.storyId !== undefined ? { storyId: parsed.storyId } : {}),
    ...(parsed.intentRef !== undefined ? { intentRef: parsed.intentRef } : {}),
  };

  if (parsed.kind === 'verification_run') {
    return {
      verdict: 'allow',
      ...base,
      reasons: ['verification_run derives its command/selector from the intent pin; there is nothing for the caller to mismatch.'],
    };
  }

  if (!pin) {
    return {
      verdict: 'allow',
      ...base,
      reasons: ['The referenced intent has no pinned verification yet; the first selector-bearing write pins it, so there is nothing to mismatch.'],
    };
  }

  const mismatches: string[] = [];
  if (parsed.callerCommand !== undefined && parsed.callerCommand !== pin.command) {
    mismatches.push(`--command "${parsed.callerCommand}" does not match the pinned command "${pin.command}"`);
  }
  if (parsed.callerSelector !== undefined && parsed.callerSelector !== pin.selector) {
    mismatches.push(`--selector "${parsed.callerSelector}" does not match the pinned selector "${pin.selector}"`);
  }

  if (mismatches.length === 0) {
    return {
      verdict: 'allow',
      ...base,
      reasons: ['Caller command/selector match the pinned verification (or were not provided).'],
    };
  }

  const ref = parsed.intentRef ?? '<intentRef>';
  const story = parsed.storyId ?? '<storyId>';
  // Rendered from the shared single source, so every argument the registered schema
  // requires is present and the reader can paste the line as printed (B-1482 F-008).
  const narrowForm = renderVerificationPinNarrowCommand({
    ...(parsed.storyId !== undefined ? { storyId: parsed.storyId } : {}),
    ...(owner?.itemId !== undefined ? { itemId: owner.itemId } : {}),
    ...(parsed.intentRef !== undefined ? { intentRef: parsed.intentRef } : {}),
  });
  return {
    verdict: 'deny',
    ...base,
    reasons: [
      `evidence-pin seatbelt: this verification_evidence_add would be refused. The intent ${ref} is already pinned to an immutable verification (B-ec67) and your write does not match it.`,
      ...mismatches,
      `Fix: run \`proof-or-stop verification_run --storyId=${story} --intentRef=${ref}\` (it re-uses the pinned command), or pass the exact pinned command/selector.`,
      // B-1482: the pin is no longer immutable WITHOUT exception — exactly one movement
      // exists. Naming it here matters because this refusal is what a caller hits the
      // moment they try a different selector against a pin that is not discriminating,
      // which is the very defect the narrowing was built for. The precondition is stated
      // with it, so the reader is not sent to a command that will refuse them for a
      // reason they were never told.
      `Third option: if the pinned selector is not discriminating — it matched a run that genuinely FAILED — re-pin it with \`${narrowForm}\`. ${VERIFICATION_PIN_NARROWING_PRECONDITION}`,
    ],
  };
}
