/** Public, already verified and redacted projection supplied by the host package. */
export interface ManagedRunView {
  readonly runId: string;
  readonly storyId: string | null;
  readonly host: string;
  readonly state: string;
  readonly stage: { readonly number: number; readonly total: number; readonly name: string };
  readonly queueReason: string | null;
  readonly lastProviderProgressAt: string | null;
  readonly durationEstimate: { readonly kind: 'historical' | 'unavailable'; readonly estimatedTerminalAt?: string; readonly sampleCount: number };
  readonly terminal: { readonly digest: string; readonly state: string; readonly reason: string; readonly terminalAt: string } | null;
}
export interface ManagedRunsView {
  readonly runs: readonly ManagedRunView[];
  readonly diagnostics: readonly string[];
}
