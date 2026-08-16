export type AgentHostTaskStatus =
  | 'foreground'
  | 'running'
  | 'background'
  | 'silent'
  | 'unknown'
  | 'unavailable'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'missing'
  | 'dead'
  | 'operator-cancelled';

export type AgentLivenessAction =
  | 'monitor-same-task'
  | 'accept-completed-result'
  | 'hold-completed'
  | 'replace-once'
  | 'hold-terminal';

export interface AgentLivenessDecision {
  action: AgentLivenessAction;
  preserveTaskIdentity: boolean;
  replacementAuthorized: boolean;
  recordReason: string | null;
}

export interface AgentLivenessObservation {
  status: AgentHostTaskStatus;
  elapsedMs: number;
  resultAlreadyConsumed?: boolean;
  replacementAlreadyAttempted: boolean;
}

const MONITOR_STATUSES = new Set<AgentHostTaskStatus>([
  'foreground',
  'running',
  'background',
  'silent',
  'unknown',
  'unavailable',
]);

const TERMINAL_FAILURE_STATUSES = new Set<AgentHostTaskStatus>([
  'failed',
  'cancelled',
  'missing',
  'dead',
  'operator-cancelled',
]);

/**
 * Decide what the host should do with one dispatched task observation.
 * elapsedMs is deliberately not a decision input: wall-clock time may trigger
 * another status observation, but cannot turn an ambiguous/live state into a
 * terminal one.
 */
export function decideAgentLiveness(observation: AgentLivenessObservation): AgentLivenessDecision {
  void observation.elapsedMs;
  if (MONITOR_STATUSES.has(observation.status)) {
    return {
      action: 'monitor-same-task',
      preserveTaskIdentity: true,
      replacementAuthorized: false,
      recordReason: null,
    };
  }
  if (observation.status === 'completed') {
    if (observation.resultAlreadyConsumed) {
      return {
        action: 'hold-completed',
        preserveTaskIdentity: true,
        replacementAuthorized: false,
        recordReason: 'original completed result already consumed',
      };
    }
    return {
      action: 'accept-completed-result',
      preserveTaskIdentity: true,
      replacementAuthorized: false,
      recordReason: null,
    };
  }
  if (!TERMINAL_FAILURE_STATUSES.has(observation.status)) {
    throw new Error(`unsupported agent host task status: ${String(observation.status)}`);
  }
  const recordReason = `authoritative terminal status: ${observation.status}`;
  if (observation.replacementAlreadyAttempted) {
    return {
      action: 'hold-terminal',
      preserveTaskIdentity: false,
      replacementAuthorized: false,
      recordReason,
    };
  }
  return {
    action: 'replace-once',
    preserveTaskIdentity: false,
    replacementAuthorized: true,
    recordReason,
  };
}

export const AGENT_LIVENESS_GUIDANCE_REQUIRED_FRAGMENTS = [
  'Host-native task liveness policy:',
  'Elapsed time or silence alone never proves a stall and never authorizes a replacement.',
  'Query the host-native task status for the original task identity.',
  'If status is foreground, running, or background, continue bounded polling/waits on that same task identity; do not dispatch a duplicate, including after 10 minutes/600s.',
  'If status is unknown or temporarily unavailable, record the uncertainty and keep monitoring the same task identity; do not dispatch a duplicate.',
  'If status is completed, consume the original result exactly once.',
  'Only an authoritative failed, cancelled, missing, or dead status (or explicit operator cancellation) authorizes at most one replacement.',
  'Explicit configured subprocess deadlines (including provider.codex and cross_host_review) are separate execution contracts and remain enforced.',
] as const;

export function renderAgentLivenessGuidance(options: {
  label: string;
  startSignal?: string;
}): string {
  const lines: string[] = [...AGENT_LIVENESS_GUIDANCE_REQUIRED_FRAGMENTS];
  if (options.startSignal) {
    lines.splice(1, 0, `After starting, first output \`${options.startSignal}\` so the host can associate progress with ${options.label}.`);
  }
  lines.splice(lines.length - 1, 0, 'Before replacing, record the terminal reason and ensure the former task can no longer write results or evidence.');
  return lines.join('\n- ');
}
