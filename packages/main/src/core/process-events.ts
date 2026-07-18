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

export function appendProcessEvent(
  storyDir: string,
  event: Omit<ProcessEvent, 'timestamp'>,
): ProcessEventAppendIdentity {
  const filePath = join(storyDir, FILENAME);
  mkdirSync(dirname(filePath), { recursive: true });
  return withMkdirLock(join(storyDir, '.process-events-append.lock'), () => {
    const start = existsSync(filePath) ? statSync(filePath).size : 0;
    const full = { ...event, timestamp: new Date().toISOString() } as ProcessEvent;
    const eventBytes = Buffer.from(`${JSON.stringify(full)}\n`);
    appendFileSync(filePath, eventBytes);
    return {
      filePath,
      start,
      end: start + eventBytes.length,
      eventBytes,
    };
  }, { label: 'process-events append' });
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
