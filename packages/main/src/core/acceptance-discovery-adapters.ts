import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { CoverageAdapterResultV1, CoverageDiscoveryMethodV1, PlannedCoveragePathV1 } from './types.js';
import { digestCanonicalJson } from './digest.js';
import { PROCESS_FACT_REGISTRY, type ProcessFactRegistryEntry } from './process-fact-registry.js';

export const ACCEPTANCE_PLAN_DISCOVERY_PROFILE = {
  ref: 'profile:typescript-proof-gate:plan:v1',
  methods: ['scope_contract', 'process_fact_registry', 'handler_dispatch_inventory', 'static_call_graph', 'runtime_trace'] as CoverageDiscoveryMethodV1[],
} as const;

export interface AcceptanceDiscoveryInput {
  supported: boolean;
  workspaceRoot: string;
  storyId: string;
  plannedPathRecords: PlannedCoveragePathV1[];
  scopeRefs: string[];
  /** Test-only bounded runtime observations; production derives without caller-authored paths. */
  runtimeObservedPathRefs?: string[];
}

export interface RegisteredProcessFactClosure {
  pathRefs: string[];
  sourceInventoryRefs: string[];
  sourceFileRefs: string[];
  blindSpots: string[];
  entries: ProcessFactRegistryEntry[];
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

function stable(values: readonly string[]): string[] {
  return [...new Set(values.filter(value => typeof value === 'string' && value.trim().length > 0))].sort();
}

function normalized(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function sourceFiles(entry: ProcessFactRegistryEntry): string[] {
  return stable([...(entry.producerSourceRefs ?? []), ...(entry.consumerSourceRefs ?? [])]);
}

function entrySourceTokens(entry: ProcessFactRegistryEntry): string[] {
  return stable([
    entry.name,
    entry.producer,
    entry.producer.split(/[/.]/).at(-1) ?? '',
    entry.artifact?.producerCommand ?? '',
    entry.artifact?.name ?? '',
  ]);
}

function processFactPath(entry: ProcessFactRegistryEntry): string {
  return `path:process-fact:${entry.name}->consumer:${entry.consumerGate ?? '<audit-only>'}`;
}

/** Resolve canonical process-fact closure and its producer/consumer source files. */
export function deriveRegisteredProcessFactClosure(workspaceRoot: string, seedRefs: readonly string[]): RegisteredProcessFactClosure {
  const seeds = stable(seedRefs.flatMap(ref => {
    const value = normalized(ref);
    const tail = normalized(ref.split(/[:#]/).at(-1) ?? ref);
    return [value, value.replace(/^(?:processfact|artifact|handler|dispatch)/, ''), tail];
  })).filter(value => value.length >= 4);
  const reached = PROCESS_FACT_REGISTRY.filter(entry => {
    const candidates = [entry.name, entry.producer, entry.artifact?.name ?? '', entry.artifact?.path ?? ''].map(normalized).filter(Boolean);
    return seeds.some(seed => candidates.some(candidate => seed.includes(candidate) || candidate.includes(seed)));
  });
  const blindSpots: string[] = [];
  for (const entry of reached) {
    if (!entry.producerSourceRefs?.length) blindSpots.push(`process fact ${entry.name} has no canonical producer source refs`);
    if (entry.consumerGate && !entry.consumerSourceRefs?.length) blindSpots.push(`process fact ${entry.name} has no canonical consumer source refs`);
    for (const file of sourceFiles(entry)) {
      if (!existsSync(resolve(workspaceRoot, file))) blindSpots.push(`uninspectable registered source ${file} for ${entry.name}`);
    }
  }
  return {
    pathRefs: stable(reached.map(processFactPath)),
    sourceInventoryRefs: stable(reached.flatMap(entry => [
      `process-fact:${entry.name}:${digestCanonicalJson(entry)}`,
      ...((entry.producerSourceRefs ?? []).map(file => `source-file:producer:${encodeURIComponent(entry.name)}:${file}`)),
      ...((entry.consumerSourceRefs ?? []).map(file => `source-file:consumer:${encodeURIComponent(entry.name)}:${file}`)),
      ...(entry.artifact ? [`artifact:${entry.artifact.path}`] : []),
    ])),
    sourceFileRefs: stable(reached.flatMap(sourceFiles)),
    blindSpots: stable(blindSpots),
    entries: reached,
  };
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

function fileContains(root: string, file: string, values: readonly string[]): boolean {
  const absolute = resolve(root, file);
  if (!existsSync(absolute)) return false;
  const text = readFileSync(absolute, 'utf8');
  return values.some(value => value.length > 0 && (text.includes(value) || normalized(text).includes(normalized(value))));
}

function sourceProvenance(root: string, file: string): string {
  const absolute = resolve(root, file);
  return existsSync(absolute)
    ? `source-file:${file}:sha256:${digestCanonicalJson(readFileSync(absolute, 'utf8'))}`
    : `source-file:${file}:uninspectable`;
}

function plannedInspectable(input: AcceptanceDiscoveryInput, record: PlannedCoveragePathV1): boolean {
  return [record.producer, ...record.consumers].every(endpoint =>
    fileContains(input.workspaceRoot, endpoint.expectedFileRef, [endpoint.expectedSymbolOrFact]));
}

function registryInspectable(input: AcceptanceDiscoveryInput, entry: ProcessFactRegistryEntry): boolean {
  const files = sourceFiles(entry);
  return files.length > 0 && files.every(file => fileContains(input.workspaceRoot, file, [...entrySourceTokens(entry), entry.consumerGate ?? '']));
}

function handlerInspectable(input: AcceptanceDiscoveryInput, entry: ProcessFactRegistryEntry): boolean {
  const producerFiles = stable(entry.producerSourceRefs ?? []);
  return producerFiles.length > 0 && producerFiles.every(file => fileContains(input.workspaceRoot, file, entrySourceTokens(entry)));
}

function buildResult(
  input: AcceptanceDiscoveryInput,
  method: CoverageDiscoveryMethodV1,
  closure: RegisteredProcessFactClosure,
): CoverageAdapterResultV1 {
  const unsupported = !input.supported;
  const boundedRuntime = method === 'runtime_trace';
  let pathRefs: string[] = [];
  let blindSpots: string[] = [];
  let provenanceRefs: string[] = [];
  if (!unsupported) {
    if (method === 'scope_contract') {
      pathRefs = input.plannedPathRecords.map(record => record.plannedPathRef);
      provenanceRefs = input.scopeRefs;
    } else if (method === 'process_fact_registry') {
      pathRefs = closure.pathRefs;
      blindSpots = closure.blindSpots;
      provenanceRefs = closure.sourceInventoryRefs;
    } else if (method === 'handler_dispatch_inventory') {
      const inspectableEntries = closure.entries.filter(entry => handlerInspectable(input, entry));
      pathRefs = inspectableEntries.map(processFactPath);
      pathRefs.push(...input.plannedPathRecords.filter(record =>
        [record.producer, ...record.consumers].some(endpoint => endpoint.expectedArtifactKind === 'handler' || endpoint.expectedArtifactKind === 'dispatch')
        && plannedInspectable(input, record)).map(record => record.plannedPathRef));
      blindSpots = closure.entries.filter(entry => !handlerInspectable(input, entry)).map(entry => `handler/dispatch source uninspectable for ${entry.name}`);
      provenanceRefs = stable(inspectableEntries.flatMap(entry => entry.producerSourceRefs ?? []).map(file => sourceProvenance(input.workspaceRoot, file)));
    } else if (method === 'static_call_graph') {
      const inspectableEntries = closure.entries.filter(entry => registryInspectable(input, entry));
      pathRefs = inspectableEntries.map(processFactPath);
      pathRefs.push(...input.plannedPathRecords.filter(record => plannedInspectable(input, record)).map(record => record.plannedPathRef));
      blindSpots = [
        ...closure.entries.filter(entry => !registryInspectable(input, entry)).map(entry => `static process-fact sources uninspectable for ${entry.name}`),
        ...input.plannedPathRecords.filter(record => !plannedInspectable(input, record)).map(record => `planned source symbols uninspectable for ${record.plannedPathRef}`),
      ];
      provenanceRefs = stable([...closure.sourceFileRefs, ...input.plannedPathRecords.flatMap(record => [record.producer, ...record.consumers].map(endpoint => endpoint.expectedFileRef))].map(file => sourceProvenance(input.workspaceRoot, file)));
    } else {
      pathRefs = stable(input.runtimeObservedPathRefs ?? []);
      provenanceRefs = [`runtime-trace:story:${input.storyId}:bounded`];
    }
  }
  const unsigned: Omit<CoverageAdapterResultV1, 'resultDigest'> = {
    schemaVersion: 'proofstory.coverage_adapter_result.v1',
    adapterId: adapterId(method),
    method,
    pathRefs: stable(pathRefs),
    coverageClaim: unsupported ? 'unsupported' : blindSpots.length > 0 ? 'partial' : 'complete_for_scope',
    blindSpots: unsupported ? [`unsupported discovery profile for ${method}`] : stable(blindSpots),
    provenanceRefs: stable(provenanceRefs.length > 0 ? provenanceRefs : [`registered:${method}:v1`]),
    asymmetryPolicy: {
      kind: unsupported ? 'unsupported' : boundedRuntime ? 'bounded_non_exhaustive' : 'exhaustive',
      policyRef: unsupported ? 'policy:unsupported:v1' : boundedRuntime ? 'policy:bounded-runtime:v1' : `policy:${method}:v1`,
      scopeRefs: stable(input.scopeRefs),
    },
  };
  return { ...unsigned, resultDigest: digestCoverageAdapterResult(unsigned) };
}

/** Run the immutable PLAN profile from canonical repository and registry inputs. */
export function runAcceptanceDiscoveryAdapters(input: AcceptanceDiscoveryInput): CoverageAdapterResultV1[] {
  const seeds = input.plannedPathRecords.flatMap(record => [record.outputFactRef, record.producer.expectedSymbolOrFact, ...record.consumers.map(item => item.expectedSymbolOrFact)]);
  const closure = deriveRegisteredProcessFactClosure(input.workspaceRoot, seeds);
  return ACCEPTANCE_PLAN_DISCOVERY_PROFILE.methods.map(method => buildResult(input, method, closure));
}

function sameSet(left: readonly string[], right: readonly string[]): boolean {
  return JSON.stringify(stable(left)) === JSON.stringify(stable(right));
}

export function reconcileAcceptanceDiscoveryResults(results: readonly CoverageAdapterResultV1[]): AcceptanceDiscoveryReconciliation {
  const diagnostics: AcceptanceDiscoveryDiagnostic[] = [];
  const byMethod = new Map<CoverageDiscoveryMethodV1, CoverageAdapterResultV1[]>();
  for (const result of results) {
    const rows = byMethod.get(result.method) ?? [];
    rows.push(result);
    byMethod.set(result.method, rows);
    if (result.schemaVersion !== 'proofstory.coverage_adapter_result.v1' || !result.adapterId || result.provenanceRefs.length === 0
      || !['complete_for_scope', 'partial', 'unsupported'].includes(result.coverageClaim)
      || !['exhaustive', 'bounded_non_exhaustive', 'unsupported'].includes(result.asymmetryPolicy?.kind)) {
      diagnostics.push({ code: 'AT_ADAPTER_RESULT_INVALID', adapterId: result.adapterId, message: `invalid adapter result ${result.adapterId || '<missing>'}` });
    }
    if (digestCoverageAdapterResult(unsignedResult(result)) !== result.resultDigest) diagnostics.push({ code: 'AT_ADAPTER_RESULT_DIGEST_MISMATCH', adapterId: result.adapterId, message: `adapter result digest mismatch: ${result.adapterId}` });
  }
  for (const method of ACCEPTANCE_PLAN_DISCOVERY_PROFILE.methods) {
    const rows = byMethod.get(method) ?? [];
    if (rows.length !== 1) diagnostics.push({ code: 'AT_REQUIRED_ADAPTER_RESULT_MISSING', message: `registered profile requires exactly one ${method} result; observed ${rows.length}`, adapterId: adapterId(method) });
  }
  const staticResult = byMethod.get('static_call_graph')?.[0];
  const runtimeResult = byMethod.get('runtime_trace')?.[0];
  if (staticResult && runtimeResult && !sameSet(staticResult.pathRefs, runtimeResult.pathRefs) && runtimeResult.asymmetryPolicy.kind !== 'bounded_non_exhaustive') {
    diagnostics.push({ code: 'AT_DISCOVERY_DISAGREEMENT', message: 'static/runtime path disagreement lacks bounded runtime asymmetry policy' });
  }
  const registryResult = byMethod.get('process_fact_registry')?.[0];
  const dispatchResult = byMethod.get('handler_dispatch_inventory')?.[0];
  const registryProcessPaths = registryResult?.pathRefs.filter(path => path.startsWith('path:process-fact:')) ?? [];
  const dispatchProcessPaths = dispatchResult?.pathRefs.filter(path => path.startsWith('path:process-fact:')) ?? [];
  if (registryResult && dispatchResult && !sameSet(registryProcessPaths, dispatchProcessPaths)) diagnostics.push({ code: 'AT_DISCOVERY_DISAGREEMENT', message: 'process-fact and handler/dispatch discovery disagree' });
  const enumeratedPathRefs = stable(results.flatMap(result => result.pathRefs));
  const blindSpots = stable(results.flatMap(result => result.blindSpots));
  const unsupported = results.some(result => result.coverageClaim === 'unsupported' || result.asymmetryPolicy.kind === 'unsupported');
  const partial = diagnostics.length > 0 || blindSpots.length > 0 || results.some(result => result.coverageClaim === 'partial');
  return { adapterResults: [...results].sort((a, b) => a.adapterId.localeCompare(b.adapterId)), enumeratedPathRefs, blindSpots,
    diagnostics: diagnostics.sort((a, b) => `${a.code}:${a.adapterId ?? ''}:${a.message}`.localeCompare(`${b.code}:${b.adapterId ?? ''}:${b.message}`)),
    status: unsupported ? 'unsupported' : partial ? 'partial' : 'complete' };
}

export function discoveryProfileDigest(): string {
  return `sha256:${digestCanonicalJson(ACCEPTANCE_PLAN_DISCOVERY_PROFILE)}`;
}
