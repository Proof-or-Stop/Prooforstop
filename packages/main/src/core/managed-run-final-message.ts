/**
 * The last assistant message of a managed run, from its retained provider
 * output (moved from handlers/next-driver.ts, old-PoS run 30: the
 * finding-repair prompt also quotes an earlier no-commit run's report).
 */
import { closeSync, openSync, readSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { managedHostRunsRoot } from './managed-host-run.js';
import { finalMessageFromLiveOutput } from './repair-report-lines.js';

/** Bytes read from the end of a managed run's retained output to find its final message. */
const FINAL_MESSAGE_TAIL_BYTES = 256 * 1024;

/**
 * The last assistant message of a managed run, from its retained provider
 * output (live-output.jsonl): codex `item.completed` agent_message, claude
 * `result`. Implementer / finding-repair results are prose, so the managed
 * final-result scanner (built for review JSON envelopes) does not keep them.
 * Null when the output is unavailable.
 */
export function managedRunFinalMessage(root: string, runId: string): string | null {
  const path = join(managedHostRunsRoot(root), runId, 'live-output.jsonl');
  let raw: string;
  try {
    const size = statSync(path).size;
    const start = Math.max(0, size - FINAL_MESSAGE_TAIL_BYTES);
    const buffer = Buffer.alloc(size - start);
    const fd = openSync(path, 'r');
    try { readSync(fd, buffer, 0, buffer.length, start); } finally { closeSync(fd); }
    raw = buffer.toString('utf8');
    if (start > 0) raw = raw.slice(raw.indexOf('\n') + 1);
  } catch {
    return null;
  }
  // Lab run89: the frame parser is shared with the managed worker's report follow-up (core/repair-report-lines.ts).
  return finalMessageFromLiveOutput(raw);
}

