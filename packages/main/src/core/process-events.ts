/**
 * B-aa48 CHK-001: Append-only process event log (JSONL format).
 * Each story gets a process-events.jsonl file for telemetry events.
 */

import { existsSync, readFileSync, appendFileSync, mkdirSync, statSync, truncateSync, unlinkSync } from 'fs';
import { join, dirname } from 'path';
import type { ProcessEvent } from './types.js';
import { withMkdirLock } from './mkdir-lock.js';

const FILENAME = 'process-events.jsonl';

export interface ProcessEventAppendIdentity {
  filePath: string;
  fileExisted: boolean;
  start: number;
  end: number;
  eventBytes: Buffer;
}

export function appendRawProcessEventBytes(
  storyDir: string,
  bytes: Buffer | string,
  // B-d877 R3 FIX B / R4 (codex #3): the RELOCATED append lock dir is now
  // MANDATORY. It must resolve under the gitignored shared
  // `.proof-or-stop/locks/process-events/` prefix (via StoryStore.runtimeLockDirPath /
  // storyRuntimeLockPath) so a transient holder.json can NEVER be created inside
  // the git-tracked story dir and dirty the tree. Making it a required parameter
  // — with NO in-story-dir fallback default — means the compiler forces every
  // append site to pass a relocated lock, so no future caller can silently
  // regress to an in-story `<storyDir>/.process-events-append.lock`.
  lockDir: string,
): ProcessEventAppendIdentity {
  const eventBytes = Buffer.isBuffer(bytes) ? Buffer.from(bytes) : Buffer.from(bytes);
  if (eventBytes.length === 0 || eventBytes[eventBytes.length - 1] !== 0x0a) {
    throw new Error('process-event append requires non-empty newline-terminated JSONL bytes');
  }
  const filePath = join(storyDir, FILENAME);
  mkdirSync(dirname(filePath), { recursive: true });
  return withMkdirLock(lockDir, () => {
    const fileExisted = existsSync(filePath);
    const start = fileExisted ? statSync(filePath).size : 0;
    appendFileSync(filePath, eventBytes);
    return {
      filePath,
      fileExisted,
      start,
      end: start + eventBytes.length,
      eventBytes,
    };
  }, { label: 'process-events append' });
}

export function rollbackProcessEventAppend(
  identity: ProcessEventAppendIdentity,
  lockDir: string,
): void {
  withMkdirLock(lockDir, () => {
    if (!existsSync(identity.filePath)) throw new Error('process-event rollback target is missing');
    const current = readFileSync(identity.filePath);
    if (current.length !== identity.end
      || identity.start < 0
      || identity.end !== identity.start + identity.eventBytes.length
      || !current.subarray(identity.start, identity.end).equals(identity.eventBytes)) {
      throw new Error('process-event rollback refused: appended bytes are no longer the exact file suffix');
    }
    if (!identity.fileExisted && identity.start === 0) unlinkSync(identity.filePath);
    else truncateSync(identity.filePath, identity.start);
  }, { label: 'process-events rollback' });
}

export function appendProcessEventRecord(
  storyDir: string,
  event: Record<string, unknown>,
  // B-d877 R4 (codex #3): mandatory relocated lock dir, threaded to the append
  // path so this wrapper cannot regress to an in-story lock either.
  lockDir: string,
): ProcessEventAppendIdentity {
  const full = typeof event.timestamp === 'string'
    ? event
    : { ...event, timestamp: new Date().toISOString() };
  return appendRawProcessEventBytes(storyDir, `${JSON.stringify(full)}\n`, lockDir);
}

export function appendProcessEventRecords(
  storyDir: string,
  events: Array<Record<string, unknown>>,
  lockDir: string,
): ProcessEventAppendIdentity {
  if (events.length === 0) throw new Error('process-event batch requires at least one event');
  const timestamp = new Date().toISOString();
  const bytes = events.map(event => JSON.stringify(
    typeof event.timestamp === 'string' ? event : { ...event, timestamp },
  )).join('\n') + '\n';
  return appendRawProcessEventBytes(storyDir, bytes, lockDir);
}

export function appendProcessEvent(
  storyDir: string,
  event: Omit<ProcessEvent, 'timestamp'>,
  // B-d877 R4 (codex #3): mandatory relocated lock dir (see appendRawProcessEventBytes).
  lockDir: string,
): ProcessEventAppendIdentity {
  return appendProcessEventRecord(storyDir, event as Record<string, unknown>, lockDir);
}

export function readProcessEvents(storyDir: string): ProcessEvent[] {
  const filePath = join(storyDir, FILENAME);
  if (!existsSync(filePath)) return [];
  const content = readFileSync(filePath, 'utf-8');
  const events: ProcessEvent[] = [];
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      events.push(JSON.parse(trimmed) as ProcessEvent);
    } catch {
      console.warn('[process-events] malformed line skipped:', trimmed.slice(0, 80));
    }
  }
  return events;
}
