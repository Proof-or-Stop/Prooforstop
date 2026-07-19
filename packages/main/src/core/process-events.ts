/**
 * B-aa48 CHK-001: Append-only process event log (JSONL format).
 * Each story gets a process-events.jsonl file for telemetry events.
 */

import { existsSync, readFileSync, appendFileSync, mkdirSync, statSync } from 'fs';
import { join, dirname } from 'path';
import type { ProcessEvent } from './types.js';
import { withMkdirLock } from './mkdir-lock.js';

const FILENAME = 'process-events.jsonl';

export interface ProcessEventAppendIdentity {
  filePath: string;
  start: number;
  end: number;
  eventBytes: Buffer;
}

export function appendRawProcessEventBytes(
  storyDir: string,
  bytes: Buffer | string,
  // B-d877 R3 FIX B: optional RELOCATED append lock dir. When provided (by
  // StoryStore.appendProcessEvent / defaultAuditWriter) the append serializes on
  // a lock under the gitignored shared `.lattice/locks/process-events/` prefix
  // instead of `<storyDir>/.process-events-append.lock` — so a transient
  // holder.json can never be committed inside the git-tracked story dir. Absent
  // (legacy/direct callers) it falls back to the in-story lock, byte-identical to
  // the pre-fix behavior.
  lockDir?: string,
): ProcessEventAppendIdentity {
  const eventBytes = Buffer.isBuffer(bytes) ? Buffer.from(bytes) : Buffer.from(bytes);
  if (eventBytes.length === 0 || eventBytes[eventBytes.length - 1] !== 0x0a) {
    throw new Error('process-event append requires non-empty newline-terminated JSONL bytes');
  }
  const filePath = join(storyDir, FILENAME);
  mkdirSync(dirname(filePath), { recursive: true });
  const appendLockDir = lockDir ?? join(storyDir, '.process-events-append.lock');
  return withMkdirLock(appendLockDir, () => {
    const start = existsSync(filePath) ? statSync(filePath).size : 0;
    appendFileSync(filePath, eventBytes);
    return {
      filePath,
      start,
      end: start + eventBytes.length,
      eventBytes,
    };
  }, { label: 'process-events append' });
}

export function appendProcessEventRecord(
  storyDir: string,
  event: Record<string, unknown>,
  lockDir?: string,
): ProcessEventAppendIdentity {
  const full = typeof event.timestamp === 'string'
    ? event
    : { ...event, timestamp: new Date().toISOString() };
  return appendRawProcessEventBytes(storyDir, `${JSON.stringify(full)}\n`, lockDir);
}

export function appendProcessEvent(
  storyDir: string,
  event: Omit<ProcessEvent, 'timestamp'>,
  lockDir?: string,
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
