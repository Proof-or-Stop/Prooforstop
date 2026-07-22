import type { CoverageAdapterResultV1, CoverageDiscoveryMethodV1 } from './types.js';
import { digestCanonicalJson } from './digest.js';
import { PROCESS_FACT_REGISTRY } from './process-fact-registry.js';

export const ACCEPTANCE_PLAN_DISCOVERY_PROFILE = {
  ref: 'profile:typescript-proof-gate:plan:v1',
  methods: [
    'scope_contract',
    'process_fact_registry',
    'handler_dispatch_inventory',
    'static_call_graph',
    'runtime_trace',
  ] as CoverageDiscoveryMethodV1[],
} as const;

export interface AcceptanceDiscoveryInput {
  supported: boolean;
  pathRefs: string[];
  scopeRefs: string[];
  provenanceByMethod?: Partial<Record<CoverageDiscoveryMethodV1, string[]>>;
  blindSpotsByMethod?: Partial<Record<CoverageDiscoveryMethodV1, string[]>>;
}

export interface AcceptanceDiscoveryDiagnostic {
  code: 'AT_REQUIRED_ADAPTER_RESULT_MISSING' | 'AT_ADAPTER_RESULT_DIGEST_MISMATCH' | 'AT_ADAPTER_RESULT_INVALID' | 'AT_DISCOVERY_DISAGREEMENT';
  message: string;
  adapterId?: string;
}

export interface AcceptanceDiscoveryReconciliation {
  adapterResults: CoverageAdapterResultV1[];
  enumeratedPathRefs: string[];
  blindSpots: string[];
  diagnostics: AcceptanceDiscoveryDiagnostic[];
  status: 'complete' | 'partial' | 'unsupported';
}

/**
 * Traverse the flat process-fact catalog from story-owned symbols/facts to all
 * registered consumers. The consumer gate is intentionally not scope-filtered:
 * global consumers remain in the closure even when their code is outside the
 * Story file set.
 */
export function deriveRegisteredProcessFactClosure(seedRefs: readonly string[]): {
  pathRefs: string[];
  sourceInventoryRefs: string[];
} {
  const normalizedSeeds = stable(seedRefs).map(value => value.toLowerCase());
  const reached = PROCESS_FACT_REGISTRY.filter(entry => normalizedSeeds.some(seed =>
    seed.includes(entry.name.toLowerCase())
    || seed.includes(entry.producer.toLowerCase())
    || Boolean(entry.artifact && (seed.includes(entry.artifact.name.toLowerCase()) || seed.includes(entry.artifact.path.toLowerCase())))));
  return {
    pathRefs: stable(reached.map(entry => `path:process-fact:${entry.name}->consumer:${entry.consumerGate ?? '<audit-only>'}`)),
    sourceInventoryRefs: stable(reached.flatMap(entry => [
      `process-fact:${entry.name}:${digestCanonicalJson(entry)}`,
      `producer:${entry.producer}`,
      ...(entry.consumerGate ? [`consumer:${entry.consumerGate}`] : []),
      ...(entry.artifact ? [`artifact:${entry.artifact.path}`] : []),
    ])),
  };
}

function stable(values: readonly string[]): string[] {
  return [...new Set(values.filter(value => typeof value === 'string' && value.trim().length > 0))].sort();
}

function unsignedResult(result: CoverageAdapterResultV1): Omit<CoverageAdapterResultV1, 'resultDigest'> {
  const { resultDigest: _resultDigest, ...unsigned } = result;
  return unsigned;
}

export function digestCoverageAdapterResult(result: Omit<CoverageAdapterResultV1, 'resultDigest'>): string {
  return `sha256:${digestCanonicalJson(result)}`;
}

function adapterId(method: CoverageDiscoveryMethodV1): string {
  return `${method.replace(/_/g, '-')}:plan:v1`;
}

function buildResult(input: AcceptanceDiscoveryInput, method: CoverageDiscoveryMethodV1): CoverageAdapterResultV1 {
  const unsupported = !input.supported;
  const boundedRuntime = method === 'runtime_trace';
  const contributesPaths = method === 'process_fact_registry'
    || method === 'handler_dispatch_inventory'
    || method === 'static_call_graph';
  const unsigned: Omit<CoverageAdapterResultV1, 'resultDigest'> = {
    schemaVersion: 'proofstory.coverage_adapter_result.v1',
    adapterId: adapterId(method),
    method,
    pathRefs: unsupported || !contributesPaths ? [] : stable(input.pathRefs),
    coverageClaim: unsupported ? 'unsupported' : 'complete_for_scope',
    blindSpots: unsupported
      ? [`unsupported discovery profile for ${method}`]
      : stable(input.blindSpotsByMethod?.[method] ?? []),
    provenanceRefs: stable(input.provenanceByMethod?.[method] ?? [`registered:${method}:v1`]),
    asymmetryPolicy: {
      kind: unsupported ? 'unsupported' : boundedRuntime ? 'bounded_non_exhaustive' : 'exhaustive',
      policyRef: unsupported ? 'policy:unsupported:v1' : boundedRuntime ? 'policy:bounded-runtime:v1' : `policy:${method}:v1`,
      scopeRefs: stable(input.scopeRefs),
    },
  };
  return { ...unsigned, resultDigest: digestCoverageAdapterResult(unsigned) };
}

/** Run the immutable PLAN profile. Callers cannot select or omit adapters. */
export function runAcceptanceDiscoveryAdapters(input: AcceptanceDiscoveryInput): CoverageAdapterResultV1[] {
  return ACCEPTANCE_PLAN_DISCOVERY_PROFILE.methods.map(method => buildResult(input, method));
}

function sameSet(left: readonly string[], right: readonly string[]): boolean {
  return JSON.stringify(stable(left)) === JSON.stringify(stable(right));
}

export function reconcileAcceptanceDiscoveryResults(
  results: readonly CoverageAdapterResultV1[],
): AcceptanceDiscoveryReconciliation {
  const diagnostics: AcceptanceDiscoveryDiagnostic[] = [];
  const byMethod = new Map<CoverageDiscoveryMethodV1, CoverageAdapterResultV1[]>();
  for (const result of results) {
    const rows = byMethod.get(result.method) ?? [];
    rows.push(result);
    byMethod.set(result.method, rows);
    if (result.schemaVersion !== 'proofstory.coverage_adapter_result.v1'
      || !result.adapterId
      || result.provenanceRefs.length === 0
      || !['complete_for_scope', 'partial', 'unsupported'].includes(result.coverageClaim)
      || !['exhaustive', 'bounded_non_exhaustive', 'unsupported'].includes(result.asymmetryPolicy?.kind)) {
      diagnostics.push({ code: 'AT_ADAPTER_RESULT_INVALID', adapterId: result.adapterId, message: `invalid adapter result ${result.adapterId || '<missing>'}` });
    }
    if (digestCoverageAdapterResult(unsignedResult(result)) !== result.resultDigest) {
      diagnostics.push({ code: 'AT_ADAPTER_RESULT_DIGEST_MISMATCH', adapterId: result.adapterId, message: `adapter result digest mismatch: ${result.adapterId}` });
    }
  }
  for (const method of ACCEPTANCE_PLAN_DISCOVERY_PROFILE.methods) {
    const rows = byMethod.get(method) ?? [];
    if (rows.length !== 1) {
      diagnostics.push({
        code: 'AT_REQUIRED_ADAPTER_RESULT_MISSING',
        message: `registered profile requires exactly one ${method} result; observed ${rows.length}`,
        adapterId: adapterId(method),
      });
    }
  }

  const staticResult = byMethod.get('static_call_graph')?.[0];
  const runtimeResult = byMethod.get('runtime_trace')?.[0];
  if (staticResult && runtimeResult && !sameSet(staticResult.pathRefs, runtimeResult.pathRefs)) {
    if (runtimeResult.asymmetryPolicy.kind !== 'bounded_non_exhaustive') {
      diagnostics.push({ code: 'AT_DISCOVERY_DISAGREEMENT', message: 'static/runtime path disagreement lacks bounded runtime asymmetry policy' });
    }
  }
  const registryResult = byMethod.get('process_fact_registry')?.[0];
  const dispatchResult = byMethod.get('handler_dispatch_inventory')?.[0];
  if (registryResult && dispatchResult && !sameSet(registryResult.pathRefs, dispatchResult.pathRefs)) {
    diagnostics.push({ code: 'AT_DISCOVERY_DISAGREEMENT', message: 'process-fact and handler/dispatch discovery disagree' });
  }

  const enumeratedPathRefs = stable(results.flatMap(result => result.pathRefs));
  const blindSpots = stable(results.flatMap(result => result.blindSpots));
  const unsupported = results.some(result => result.coverageClaim === 'unsupported')
    || results.some(result => result.asymmetryPolicy.kind === 'unsupported');
  const partial = diagnostics.length > 0
    || blindSpots.length > 0
    || results.some(result => result.coverageClaim === 'partial');
  return {
    adapterResults: [...results].sort((a, b) => a.adapterId.localeCompare(b.adapterId)),
    enumeratedPathRefs,
    blindSpots,
    diagnostics: diagnostics.sort((a, b) => `${a.code}:${a.adapterId ?? ''}:${a.message}`.localeCompare(`${b.code}:${b.adapterId ?? ''}:${b.message}`)),
    status: unsupported ? 'unsupported' : partial ? 'partial' : 'complete',
  };
}

export function discoveryProfileDigest(): string {
  return `sha256:${digestCanonicalJson(ACCEPTANCE_PLAN_DISCOVERY_PROFILE)}`;
}
