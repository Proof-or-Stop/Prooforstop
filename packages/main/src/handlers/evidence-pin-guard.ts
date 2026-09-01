/**
 * evidence-pin-guard handler — Proof-or-Stop verification_pin_guard_check
 *
 * B-1507 CHK-003. Read-only PreToolUse seatbelt command for the shell-tool hooks
 * on both hosts (Claude `Bash`, Codex shell tool). Mirrors prewrite-guard.ts:
 * this file wires I/O (extracting the command string, loading the checklist) and
 * delegates the verdict computation to the pure logic in core/evidence-pin-guard.ts.
 *
 * FAIL-OPEN by contract: the seatbelt must NEVER block legitimate work. Any
 * unresolved / ambiguous condition (non-shell tool, unparseable command, missing
 * storyId/intentRef, missing story/checklist, no pin yet) resolves to ALLOW. The
 * real enforcement floor is enforceAndStampEvidence in handlers/checklist.ts.
 */

import type { HandlerContext } from './context.js';
import type { ChecklistData, VerificationIntentPin } from '../core/types.js';
import {
  parseEvidenceCommand,
  resolvePinFromChecklist,
  computeEvidencePinVerdict,
  type EvidencePinGuardResult,
} from '../core/evidence-pin-guard.js';

// ── Command-string extraction ──

/**
 * Resolve the shell command string to inspect. Prefer an explicit commandString;
 * otherwise pull `.command` out of the shell tool's input JSON (Claude `Bash`
 * and Codex shell tools both carry the command there).
 */
function resolveCommandString(args: {
  commandString?: string;
  toolInputJson?: string;
}): string | null {
  if (typeof args.commandString === 'string' && args.commandString.trim().length > 0) {
    return args.commandString;
  }
  if (typeof args.toolInputJson === 'string' && args.toolInputJson.trim().length > 0) {
    try {
      const input = JSON.parse(args.toolInputJson) as unknown;
      if (input && typeof input === 'object' && !Array.isArray(input)) {
        const command = (input as Record<string, unknown>).command;
        if (typeof command === 'string' && command.trim().length > 0) return command;
      }
    } catch {
      // PROBE: malformed tool input → fail-open (no command to inspect).
    }
  }
  return null;
}

function allowNoDecision(reason: string): EvidencePinGuardResult {
  return { verdict: 'allow', matched: false, reasons: [reason] };
}

// ── Handler factory ──

export function createEvidencePinGuardHandlers(ctx: HandlerContext): Record<string, (...args: any[]) => any> {
  const { store } = ctx;

  return {
    verification_pin_guard_check(args: {
      provider?: string;
      toolName?: string;
      toolInputJson?: string;
      commandString?: string;
      cwd?: string;
      json?: boolean;
    }): string {
      const result = evaluate();

      function evaluate(): EvidencePinGuardResult {
        // 1. Extract the command string (fail-open when absent).
        const commandString = resolveCommandString({
          commandString: args.commandString,
          toolInputJson: args.toolInputJson,
        });
        if (!commandString) {
          return allowNoDecision('No shell command string to inspect — proceeding (no-decision).');
        }

        // 2. Recognize the evidence-write invocation (fail-open when it is not one).
        const parsed = parseEvidenceCommand(commandString);
        if (!parsed) {
          return allowNoDecision('Not a proof-or-stop verification evidence-write command — proceeding (no-decision).');
        }

        // 3. Resolve the pin via the store (fail-open on any read/resolution gap).
        let pin: VerificationIntentPin | null = null;
        if (parsed.storyId && parsed.intentRef) {
          try {
            store.readStory(parsed.storyId); // ensure the story exists
            const checklist: ChecklistData = store.readChecklist(parsed.storyId);
            pin = resolvePinFromChecklist(checklist, parsed.intentRef);
          } catch {
            // PROBE: cannot resolve the pin → fail-open, let the handler floor decide.
            return computeEvidencePinVerdict(parsed, null);
          }
        }

        // 4. Pure verdict (deny only on an explicit provided-value mismatch).
        return computeEvidencePinVerdict(parsed, pin);
      }

      if (args.json) return JSON.stringify(result, null, 2);
      return renderEvidencePinGuardResult(result);
    },
  };
}

function renderEvidencePinGuardResult(result: EvidencePinGuardResult): string {
  const lines: string[] = [];
  lines.push(`verification_pin_guard_check: ${result.verdict.toUpperCase()}`);
  if (result.storyId) lines.push(`story: ${result.storyId}`);
  if (result.intentRef) lines.push(`intentRef: ${result.intentRef}`);
  lines.push('reasons:');
  for (const r of result.reasons) lines.push(`  ${r}`);
  if (!result.matched) {
    lines.push('note: not an evidence-write command — fail-open allow (no-decision)');
  }
  return lines.join('\n');
}
