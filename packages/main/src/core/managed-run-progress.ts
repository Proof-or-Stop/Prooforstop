/** Observed lifecycle facts; none of these diagnostics authorize replacement. */
export type ManagedProviderObservation = 'alive' | 'missing' | 'identity_changed' | 'unknown';
export type ManagedSupervisionCode = 'provider_missing' | 'provider_identity_changed'
  | 'provider_probe_unavailable' | 'provider_launch_stalled' | 'result_finalization_stalled';
export interface ManagedSupervisionDiagnostic {
  code: ManagedSupervisionCode;
  observedAt: string;
  action: string;
}
export interface ManagedRunStage {
  number: number;
  total: 5;
  name: 'accepted' | 'starting_provider' | 'provider_running' | 'finalizing_result' | 'terminal';
}

export function managedRunStage(input: {
  terminal: boolean; state: string; providerStarted: boolean; providerClosed: boolean;
}): ManagedRunStage {
  if (input.terminal) return {number:5,total:5,name:'terminal'};
  if (input.providerClosed) return {number:4,total:5,name:'finalizing_result'};
  if (input.providerStarted) return {number:3,total:5,name:'provider_running'};
  if (input.state === 'running') return {number:2,total:5,name:'starting_provider'};
  return {number:1,total:5,name:'accepted'};
}

export function managedSupervisionAction(code: ManagedSupervisionCode): string {
  switch (code) {
    case 'provider_missing': return 'Inspect worker logs and recover or cancel this run; do not redispatch before replacement safety is proven.';
    case 'provider_identity_changed': return 'Inspect the recorded provider identity; recover this run without signalling an unverified process.';
    case 'provider_probe_unavailable': return 'Restore process inspection capability and inspect this run; missing probe data cannot prove provider exit.';
    case 'provider_launch_stalled': return 'Inspect worker startup and admission logs, then recover or cancel this run.';
    case 'result_finalization_stalled': return 'Inspect result validation and process cleanup logs; recover finalization using the same run identity.';
  }
}
