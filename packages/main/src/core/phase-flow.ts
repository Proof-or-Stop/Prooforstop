/**
 * @task B-fc3b
 * @checklist CHK-001
 * @title centralize story phase ordinals and transition graph
 * @type feature
 * @priority high
 * @description
 *   Koala status needs a stable phase number for humans and agents, but
 *   health checks cannot rely on simple +1 ordering because Koala allows
 *   explicit rollback transitions. This module is a read-only projection of
 *   phase ordering and allowed transitions for display/diagnostics.
 *   因此不能用“当前编号必须等于上个编号 +1”来判错；健康检查必须使用合法
 *   transition graph, including rollback and terminal transitions.
 * @changes
 *   - [CHK-001] Define phase order, ordinal metadata, and legal transitions
 *   - [CHK-001] Expose helpers for ranking, formatting, and transition health
 */
import type { StoryPhase } from './types.js';

export const ACTIVE_PHASE_ORDER = [
  'IDEA',
  'INIT',
  'INIT_CHECK',
  'PLAN',
  'DEV',
  'REVIEW',
  'TEST',
  'DONE',
] as const satisfies readonly StoryPhase[];

export const TERMINAL_PHASES = ['DONE', 'DISCARDED'] as const satisfies readonly StoryPhase[];

export const PHASE_ORDER = [
  ...ACTIVE_PHASE_ORDER,
  'TEST_CASE',
  'TEST_CASE_REVIEW',
  'META',
  'DISCARDED',
] as const satisfies readonly StoryPhase[];

export type PhaseTransitionKind = 'forward' | 'rollback' | 'terminal' | 'legacy';

export interface PhaseInfo {
  phase: StoryPhase;
  ordinal: number;
  total: number;
  label: string;
  terminal: boolean;
  allowedNext: StoryPhase[];
  allowedRollback: StoryPhase[];
}

export interface PhaseTransitionHealth {
  from: string;
  to: string;
  ok: boolean;
  kind: PhaseTransitionKind | 'same' | 'unknown' | 'invalid';
  warning: string | null;
}

const ACTIVE_TOTAL = ACTIVE_PHASE_ORDER.length;

const FORWARD_TRANSITIONS: Record<StoryPhase, StoryPhase[]> = {
  IDEA: ['INIT', 'PLAN'],
  INIT: ['INIT_CHECK'],
  INIT_CHECK: ['PLAN', 'DEV'],
  PLAN: ['DEV'],
  DEV: ['REVIEW', 'PLAN'],
  REVIEW: ['TEST', 'DEV'],
  // Legacy phases remain readable for old data only.
  TEST_CASE: ['TEST_CASE_REVIEW', 'DEV'],
  TEST_CASE_REVIEW: ['TEST', 'DEV', 'TEST_CASE'],
  TEST: ['DONE', 'DEV'],
  DONE: [],
  DISCARDED: [],
  META: [],
};

const ROLLBACK_TRANSITIONS = new Set<string>([
  'DEV->PLAN',
  'REVIEW->DEV',
  'TEST_CASE->DEV',
  'TEST_CASE_REVIEW->DEV',
  'TEST_CASE_REVIEW->TEST_CASE',
  'TEST->DEV',
]);

export function isStoryPhase(value: string): value is StoryPhase {
  return (PHASE_ORDER as readonly string[]).includes(value);
}

export function normalizeLegacyPhase(phase: string): StoryPhase {
  if (phase === 'TEST_CASE') return 'DEV';
  if (phase === 'TEST_CASE_REVIEW') return 'REVIEW';
  if (isStoryPhase(phase)) return phase;
  return phase as StoryPhase;
}

export function phaseRank(phase: string): number {
  const index = (PHASE_ORDER as readonly string[]).indexOf(phase);
  return index === -1 ? -1 : index;
}

export function getPhaseInfo(phase: string): PhaseInfo | null {
  if (!isStoryPhase(phase)) return null;
  const activeIndex = (ACTIVE_PHASE_ORDER as readonly string[]).indexOf(phase);
  const terminal = (TERMINAL_PHASES as readonly string[]).includes(phase);
  return {
    phase,
    ordinal: activeIndex === -1 ? ACTIVE_TOTAL : activeIndex + 1,
    total: ACTIVE_TOTAL,
    label: phase,
    terminal,
    allowedNext: (FORWARD_TRANSITIONS[phase] || []).filter((next) => !ROLLBACK_TRANSITIONS.has(`${phase}->${next}`)),
    allowedRollback: (FORWARD_TRANSITIONS[phase] || []).filter((next) => ROLLBACK_TRANSITIONS.has(`${phase}->${next}`)),
  };
}

export function formatPhaseOrdinal(phase: string): string {
  const info = getPhaseInfo(phase);
  if (!info) return `?/ ${ACTIVE_TOTAL} ${phase}`;
  return `${info.ordinal}/${info.total} ${info.label}`;
}

export function describeAllowedTransitions(phase: string): string[] {
  const info = getPhaseInfo(phase);
  if (!info) return [`transition health: unknown phase ${phase}`];
  const lines: string[] = [];
  if (info.allowedNext.length > 0) lines.push(`allowed next: ${info.allowedNext.join(', ')}`);
  if (info.allowedRollback.length > 0) lines.push(`allowed rollback: ${info.allowedRollback.join(', ')}`);
  if (info.terminal) lines.push('terminal phase');
  if (lines.length === 0) lines.push('allowed next: none');
  return lines;
}

export function checkPhaseTransition(from: string, to: string): PhaseTransitionHealth {
  if (!isStoryPhase(from) || !isStoryPhase(to)) {
    return {
      from,
      to,
      ok: false,
      kind: 'unknown',
      warning: `unknown phase transition ${from} -> ${to}`,
    };
  }
  if (from === to) {
    return { from, to, ok: true, kind: 'same', warning: null };
  }
  const key = `${from}->${to}`;
  const allowed = FORWARD_TRANSITIONS[from] || [];
  if (allowed.includes(to)) {
    const kind: PhaseTransitionKind = ROLLBACK_TRANSITIONS.has(key) ? 'rollback' : (to === 'DONE' || to === 'DISCARDED' ? 'terminal' : 'forward');
    return { from, to, ok: true, kind, warning: null };
  }
  return {
    from,
    to,
    ok: false,
    kind: 'invalid',
    warning: `unexpected phase transition ${from} -> ${to}`,
  };
}
