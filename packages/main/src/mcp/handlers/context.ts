
import { StoryStore } from '../../story/store.js';
import type { StoryPhase, StoryEvent } from '../../story/types.js';
import { execSync } from 'child_process';
import { join } from 'path';
import { randomBytes } from 'crypto';

export interface HandlerContext {
  store: StoryStore;
  root: string;
  scanRoot: string;
  /** 流式日志输出（MCP 环境走 sendLoggingMessage，其他环境走 console.log） */
  log?: (msg: string) => void;
}

const PHASE_TO_EVENT: Record<string, string> = {
  PLAN: 'PLAN',
  DEV: 'START',
  TEST: 'REVIEW',
  DONE: 'FINISH',
};

export { PHASE_TO_EVENT };

export function collectContext(phase: StoryPhase, action: 'create' | 'advance'): StoryEvent {
  const event: StoryEvent = {
    phase,
    action,
    timestamp: new Date().toISOString(),
  };
  try { event.branch = execSync('git rev-parse --abbrev-ref HEAD', { encoding: 'utf8' }).trim(); } catch {}
  try { event.user = execSync('git config user.name', { encoding: 'utf8' }).trim(); } catch {}
  event.sessionId = process.env.KOALA_SESSION_ID
    || process.env.CLAUDE_SESSION_ID
    || undefined;
  event.agent = process.env.KOALA_AGENT || 'main';
  return event;
}

export function nextStoryId(store: StoryStore, prefix = 'B'): string {
  const existing = new Set(store.listStoryIds());
  for (let attempt = 0; attempt < 100; attempt++) {
    const hex = randomBytes(2).toString('hex'); // 4 chars, e.g. "a3f7"
    const id = `${prefix}-${hex}`;
    if (!existing.has(id)) return id;
  }
  // fallback: 6 chars for extreme collision cases
  return `${prefix}-${randomBytes(3).toString('hex')}`;
}
