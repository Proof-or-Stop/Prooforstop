/**
 * B-aa48 CHK-001: Append-only process event log (JSONL format).
 * Each story gets a process-events.jsonl file for telemetry events.
 */

import { existsSync, readFileSync, appendFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import type { ProcessEvent } from './types.js';

const FILENAME = 'process-events.jsonl';

export function appendProcessEvent(storyDir: string, event: Omit<ProcessEvent, 'timestamp'>): void {
  const filePath = join(storyDir, FILENAME);
  mkdirSync(dirname(filePath), { recursive: true });
  const full = { ...event, timestamp: new Date().toISOString() } as ProcessEvent;
  appendFileSync(filePath, JSON.stringify(full) + '\n', 'utf-8');
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
