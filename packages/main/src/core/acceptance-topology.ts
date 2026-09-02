import type {
  AcceptanceBasisArtifactV1,
  AcceptanceVerificationTopologyV1,
  ChecklistData,
  ChecklistItem,
  MilestoneLedgerData,
  ProofStoryAcceptanceBinding,
  ProofStoryContractData,
  VerificationIntent,
  VerificationIntentItem,
  VerificationPlannedPathDeclarationV1,
  VerificationPlannedPathEndpointV1,
} from './types.js';
import type { AcceptanceBasisDiagnostic } from './acceptance-coverage-basis.js';
import type { AcceptanceBasisReceiptVerification } from './acceptance-basis-receipt.js';
import { PROCESS_FACT_REGISTRY } from './process-fact-registry.js';

export const ACCEPTANCE_TOPOLOGY_SCHEMA_VERSION = 'proofstory.acceptance_topology.v1' as const;
export const PLANNED_PATH_SCHEMA_VERSION = 'proofstory.verification_planned_path_declaration.v1' as const;

export type AcceptanceTopologyResult = 'legacy_missing' | 'warning' | 'inconclusive_basis_unverified';

export interface AcceptanceTopologyDiagnostic {
  code: string;
  bindingId: string;
  path: string;
  message: string;
}

export interface AcceptanceMatrixRow {
  acceptanceBindingRef: string;
  checklistRefs: string[];
  verificationIntentRefs: string[];
  milestoneRefs: string[];
  plannedPathDeclarationRefs: string[];
  endpointRefs: string[];
  evidenceRefs: string[];
  topologyState: 'configured' | 'legacy_missing';
  result: AcceptanceTopologyResult;
  diagnosticCodes: string[];
}

export interface AcceptanceMatrixReport {
  storyId: string;
  mode: 'observe';
  readOnly: true;
  evidentiary: false;
  topologyState: 'configured' | 'legacy_missing' | 'mixed';
  result: AcceptanceTopologyResult;
  rows: AcceptanceMatrixRow[];
  diagnostics: AcceptanceTopologyDiagnostic[];
}

export type AcceptanceTopologyGateMode = 'observe' | 'warn' | 'enforce';

export interface AcceptanceTopologyCheckReport {
  storyId: string;
  mode: AcceptanceTopologyGateMode;
  readOnly: true;
  evidentiary: false;
  authority: 'diagnostic_only';
  status: 'pass' | 'fail' | 'inconclusive';
  structuralPass: boolean;
  blocking: boolean;
  basisStatus: 'missing' | 'complete' | 'partial' | 'unsupported';
  topologyState: AcceptanceMatrixReport['topologyState'];
  rows: AcceptanceMatrixRow[];
  diagnostics: AcceptanceTopologyDiagnostic[];
  nextAction: string;
}

const TOPOLOGY_KEYS = new Set([
  'schemaVersion',
  'producerRefs',
  'consumerRefs',
  'positiveAssertionRefs',
  'mutationCaseRefs',
  'transcriptAssertionRefs',
  'commandRefs',
]);

const AUTHORITY_KEYS = new Set(['authority', 'evidenceAuthority', 'coverageBasisRef', 'coverageBasisDigest', 'freshness']);
const RESULT_KEYS = new Set(['result', 'status', 'verdict', 'observedResult', 'observedOutput', 'complete', 'ready']);
const SEMANTIC_OVERRIDE_KEYS = new Set([
  'relation', 'role', 'kind', 'outputFact', 'inputFact', 'expectedFileRef',
  'expectedSymbolOrFact', 'outputFactRef', 'producer', 'consumers',
]);

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function stableUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

function stableDiagnostics(values: readonly AcceptanceTopologyDiagnostic[]): AcceptanceTopologyDiagnostic[] {
  const byKey = new Map<string, AcceptanceTopologyDiagnostic>();
  for (const value of values) {
    byKey.set(`${value.bindingId}\0${value.code}\0${value.path}\0${value.message}`, value);
  }
  return [...byKey.values()].sort((a, b) =>
    `${a.bindingId}\0${a.code}\0${a.path}\0${a.message}`.localeCompare(`${b.bindingId}\0${b.code}\0${b.path}\0${b.message}`));
}

export function verificationIntentHasPlannedPathDeclarations(intent: VerificationIntent | undefined): boolean {
  if (!intent) return false;
  return (['happy', 'edge', 'adversarial'] as const).some(lane =>
    (intent[lane] ?? []).some(item => (item.plannedPathDeclarations?.length ?? 0) > 0));
}

/** Stable projection used by writer guards; additions, edits, moves and removals all change it. */
export function plannedPathDeclarationSnapshot(intent: VerificationIntent | undefined): string {
  if (!intent) return '[]';
  const rows = (['happy', 'edge', 'adversarial'] as const).flatMap(lane =>
    (intent[lane] ?? []).flatMap((item, index) =>
      (item.plannedPathDeclarations ?? []).map(declaration => ({
        intentRef: item.id || `${lane}:${index}`,
        declaration,
      }))));
  return JSON.stringify(rows);
}

export type AcceptanceMatrixEvidenceProvenance =
  | { kind: 'producer_command'; producerCommand: 'acceptance_matrix' }
  | { kind: 'legacy_exact_projection'; marker: 'reserved_result' | 'text_line' | 'json_non_evidentiary' };

function recordedCommandTokens(command: string): string[] {
  return command
    .trim()
    .split(/\s+/)
    .map(token => token.replace(/^["']|["']$/g, ''))
    .filter(Boolean);
}

function basename(token: string): string {
  return token.replace(/\\/g, '/').split('/').pop() ?? token;
}

// This is a provenance parser, not command resolution. The retired spellings remain
// recognizable only so already-recorded acceptance_matrix rows stay classified as
// non-evidentiary; no executable, bin map, generation path, or runtime dispatch alias
// is restored by listing them here.
const HISTORICAL_ACCEPTANCE_WRAPPER_BASENAME = 'lattice acceptance_matrix'.split(' ', 1)[0];
const ACCEPTANCE_WRAPPER_BASENAMES = ['proof-or-stop', HISTORICAL_ACCEPTANCE_WRAPPER_BASENAME] as const;
const ACCEPTANCE_WRAPPER_SCRIPTS = ['bin/proof-or-stop.js', 'bin/proofOrStop.js', 'bin/lattice'] as const;
const HISTORICAL_ACCEPTANCE_WRAPPER_SCRIPT = `${ACCEPTANCE_WRAPPER_SCRIPTS[2]}.js`;

function isProofOrStopWrapper(token: string): boolean {
  const normalized = token.replace(/\\/g, '/').replace(/^\.\//, '');
  const base = basename(normalized);
  return (ACCEPTANCE_WRAPPER_BASENAMES as readonly string[]).includes(base)
    || normalized === HISTORICAL_ACCEPTANCE_WRAPPER_SCRIPT
    || normalized.endsWith(`/${HISTORICAL_ACCEPTANCE_WRAPPER_SCRIPT}`)
    || (ACCEPTANCE_WRAPPER_SCRIPTS as readonly string[]).some(
      script => normalized === script || normalized.endsWith(`/${script}`),
    );
}

function skipsRootOption(tokens: string[], index: number): number {
  if (tokens[index] === '--root' && tokens[index + 1]) return index + 2;
  if (tokens[index]?.startsWith('--root=')) return index + 1;
  return index;
}

function invokesAcceptanceMatrix(command: string): boolean {
  const tokens = recordedCommandTokens(command);
  if (tokens.length < 2) return false;
  let subcommandIndex: number;
  if (isProofOrStopWrapper(tokens[0])) {
    subcommandIndex = 1;
  } else if ((basename(tokens[0]) === 'node' || basename(tokens[0]) === 'nodejs') && isProofOrStopWrapper(tokens[1])) {
    subcommandIndex = 2;
  } else {
    return false;
  }
  let nextIndex = skipsRootOption(tokens, subcommandIndex);
  while (nextIndex !== subcommandIndex) {
    subcommandIndex = nextIndex;
    nextIndex = skipsRootOption(tokens, subcommandIndex);
  }
  return tokens[subcommandIndex] === 'acceptance_matrix';
}

/**
 * Derive non-evidentiary provenance from the recorded producer command whenever
 * possible. Legacy rows have no typed producer field, so compatibility is
 * deliberately bounded to exact matrix-only markers. Human prose is not parsed
 * as a protocol: a generic sentence beginning `Result: warning ...` remains
 * ordinary evidence, while the reserved matrix result token cannot be
 * paraphrased around the guard.
 */
export function acceptanceMatrixEvidenceProvenance(
  evidence: { kind?: string; command?: string; note?: string },
): AcceptanceMatrixEvidenceProvenance | null {
  if (invokesAcceptanceMatrix(evidence.command ?? '')) {
    return { kind: 'producer_command', producerCommand: 'acceptance_matrix' };
  }
  if (evidence.kind !== 'manual_transcript') return null;
  const note = evidence.note ?? '';
  if (/(?:^|[^a-z0-9_])(?:inconclusive_basis_unverified|legacy_missing)(?:$|[^a-z0-9_])/i.test(note)) {
    return { kind: 'legacy_exact_projection', marker: 'reserved_result' };
  }
  if (/(?:^|\n)\s*(?:Acceptance matrix for\b.*|Mode:\s*observe(?:\s*\([^\n]*\))?|Topology state:\s*(?:configured|mixed)|Result:\s*warning)\s*(?:\n|$)/m.test(note)) {
    return { kind: 'legacy_exact_projection', marker: 'text_line' };
  }
  if (/"evidentiary"\s*:\s*false(?:\s*[,}])/.test(note)) {
    return { kind: 'legacy_exact_projection', marker: 'json_non_evidentiary' };
  }
  return null;
}

/** L0 matrix output is never admissible verification or gate evidence. */
export function isAcceptanceMatrixDerivedEvidence(evidence: { kind?: string; command?: string; note?: string }): boolean {
  return acceptanceMatrixEvidenceProvenance(evidence) !== null;
}

export function validatePlannedPathDeclarationsForChecklistItem(item: ChecklistItem, intent: VerificationIntent): void {
  const declarationIds = new Set<string>();
  const endpointIds = new Set<string>();
  for (const lane of ['happy', 'edge', 'adversarial'] as const) {
    for (const [intentIndex, intentItem] of (intent[lane] ?? []).entries()) {
      for (const [declarationIndex, declaration] of (intentItem.plannedPathDeclarations ?? []).entries()) {
        const base = `verificationIntent.${lane}[${intentIndex}].plannedPathDeclarations[${declarationIndex}]`;
        if (declarationIds.has(declaration.id)) throw new Error(`${base}.id duplicates planned declaration ${declaration.id} [planned_path_duplicate_id]`);
        declarationIds.add(declaration.id);
        for (const endpoint of [declaration.producer, ...declaration.consumers]) {
          if (endpointIds.has(endpoint.id)) throw new Error(`${base} endpoint id ${endpoint.id} is not unique in ${item.id} [planned_path_duplicate_endpoint_id]`);
          endpointIds.add(endpoint.id);
          validateEndpointFileDeclaration(item, endpoint, base);
        }
      }
    }
  }
}

function validateEndpointFileDeclaration(item: ChecklistItem, endpoint: VerificationPlannedPathEndpointV1, base: string): void {
  const normalizedFile = canonicalRepositoryRelativePath(endpoint.expectedFileRef);
  if (!normalizedFile) throw new Error(`${base}.expectedFileRef must be a canonical repository-relative path [planned_path_file_ref_unsafe]`);
  const match = endpoint.fileDeclarationRef.match(/^(CHK-\d{3}):files:(modify|create|test):(\d+)$/);
  if (!match) throw new Error(`${base}.fileDeclarationRef must match CHK-NNN:files:{modify|create|test}:index [planned_path_file_ref_invalid]`);
  const [, itemRef, group, rawIndex] = match;
  if (itemRef !== item.id) throw new Error(`${base}.fileDeclarationRef must point to ${item.id} [planned_path_file_ref_wrong_item]`);
  const file = item.files?.[group as 'modify' | 'create' | 'test']?.[Number(rawIndex)];
  if (!file) throw new Error(`${base}.fileDeclarationRef does not resolve to a declared file [planned_path_file_ref_unresolved]`);
  if (file !== endpoint.expectedFileRef) {
    throw new Error(`${base}.expectedFileRef must equal ${endpoint.fileDeclarationRef} (${file}) [planned_path_file_ref_mismatch]`);
  }
}

function canonicalRepositoryRelativePath(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0 || value !== value.trim() || value.includes('\\')
    || /[\x00-\x1f\x7f]/.test(value) || value.startsWith('/') || /^[A-Za-z]:/.test(value)
    || value.startsWith('./') || value.includes('//')) return null;
  const segments = value.split('/');
  if (segments.some(segment => segment.length === 0 || segment === '.' || segment === '..')) return null;
  if (!/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/.test(value)) return null;
  return value;
}

interface IntentIndexEntry {
  itemId: string;
  intentRef: string;
  lane: 'happy' | 'edge' | 'adversarial';
  intent: VerificationIntentItem;
}

function indexIntents(checklist: ChecklistData): IntentIndexEntry[] {
  const result: IntentIndexEntry[] = [];
  for (const item of checklist.items) {
    for (const lane of ['happy', 'edge', 'adversarial'] as const) {
      for (const [index, intent] of (item.verificationIntent?.[lane] ?? []).entries()) {
        result.push({ itemId: item.id, intentRef: intent.id || `${item.id}:${lane}:${index}`, lane, intent });
      }
    }
  }
  return result;
}

function plannedDeclarationIndex(intents: readonly IntentIndexEntry[]): Map<string, VerificationPlannedPathDeclarationV1> {
  const result = new Map<string, VerificationPlannedPathDeclarationV1>();
  for (const entry of intents) {
    for (const declaration of entry.intent.plannedPathDeclarations ?? []) {
      result.set(`${entry.intentRef}:${declaration.id}`, declaration);
    }
  }
  return result;
}

function canonicalSourceRefs(
  bindings: readonly ProofStoryAcceptanceBinding[],
  checklist: ChecklistData,
  ledger: MilestoneLedgerData | null,
  intents: readonly IntentIndexEntry[],
): Set<string> {
  const refs = new Set<string>();
  bindings.forEach(binding => refs.add(`acceptance-binding:${binding.id}`));
  checklist.items.forEach(item => {
    refs.add(`checklist:${item.id}`);
    (item.verificationEvidence ?? []).forEach((evidence, index) => refs.add(`evidence:${item.id}:${evidence.intentRef}:${index}`));
  });
  intents.forEach(entry => refs.add(`intent:${entry.intentRef}`));
  (ledger?.milestones ?? []).forEach(milestone => refs.add(`milestone:${milestone.id}`));
  PROCESS_FACT_REGISTRY.forEach(entry => refs.add(`process-fact:${entry.name}`));
  return refs;
}

function pushDiagnostic(
  diagnostics: AcceptanceTopologyDiagnostic[], bindingId: string, code: string, path: string, message: string,
): void {
  diagnostics.push({ code, bindingId, path, message });
}

export function isAcceptanceBasisPathSourceRef(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 8_192 || value !== value.trim()) return false;
  if (/[\x00-\x1f\x7f]/.test(value)) return false;
  const sourceFile = '([A-Za-z0-9_.-]+(?:/[A-Za-z0-9_.-]+)*\\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs))';
  const symbol = '[A-Za-z_$][A-Za-z0-9_$]*';
  const staticCall = new RegExp(`^basis-path:path:static-call:${sourceFile}#${symbol}->consumer:${sourceFile}#${symbol}$`);
  const staticMatch = value.match(staticCall);
  if (staticMatch) return canonicalRepositoryRelativePath(staticMatch[1]) === staticMatch[1]
    && canonicalRepositoryRelativePath(staticMatch[2]) === staticMatch[2];
  const factName = '[a-z][a-z0-9_:.-]*';
  const registryConsumer = '[A-Za-z0-9_ ():<>,&-]+';
  if (value.includes('..')) return false;
  return new RegExp(`^basis-path:path:process-fact:${factName}->consumer:${registryConsumer}$`).test(value)
    || new RegExp(`^basis-path:path:runtime-fact:${factName}->checker:${registryConsumer}$`).test(value);
}

function isBasisReconciledSourcePosition(path: string): boolean {
  return path.startsWith('verificationTopology.producerRefs[')
    || path.startsWith('verificationTopology.consumerRefs[')
    || path.startsWith('verificationTopology.commandRefs[');
}

function validateSourceRef(
  ref: unknown,
  path: string,
  bindingId: string,
  canonicalRefs: ReadonlySet<string>,
  declarations: ReadonlyMap<string, VerificationPlannedPathDeclarationV1>,
  diagnostics: AcceptanceTopologyDiagnostic[],
  expectedPlannedRole?: 'producer' | 'consumer',
): string[] {
  if (!ref || typeof ref !== 'object') {
    pushDiagnostic(diagnostics, bindingId, 'AT_UNKNOWN_REF', path, 'sourceRef must be an existing or planned reference');
    return [];
  }
  const obj = ref as Record<string, unknown>;
  const forbidden = Object.keys(obj).filter(key => SEMANTIC_OVERRIDE_KEYS.has(key));
  if (forbidden.length > 0) {
    pushDiagnostic(diagnostics, bindingId, 'AT_PLANNED_PATH_DECLARATION_DRIFT', path, `sourceRef restates declaration-owned semantics: ${forbidden.sort().join(', ')}`);
  }
  if (obj.refKind === 'existing') {
    if (!nonEmpty(obj.canonicalSourceRef)
      || (!canonicalRefs.has(obj.canonicalSourceRef)
        && !(isBasisReconciledSourcePosition(path) && isAcceptanceBasisPathSourceRef(obj.canonicalSourceRef)))) {
      pushDiagnostic(diagnostics, bindingId, 'AT_UNKNOWN_REF', path, `unknown canonical source ref: ${String(obj.canonicalSourceRef ?? '')}`);
      return [];
    }
    return [obj.canonicalSourceRef];
  }
  if (obj.refKind === 'planned') {
    if (!nonEmpty(obj.plannedPathDeclarationRef) || !nonEmpty(obj.endpointRef)) {
      pushDiagnostic(diagnostics, bindingId, 'AT_PLANNED_PATH_DECLARATION_MISSING', path, 'planned source requires declaration and endpoint refs');
      return [];
    }
    const declaration = declarations.get(obj.plannedPathDeclarationRef);
    const endpoints = declaration ? [declaration.producer, ...declaration.consumers] : [];
    const endpoint = endpoints.find(candidate => candidate.id === obj.endpointRef);
    if (!declaration || !endpoint) {
      pushDiagnostic(diagnostics, bindingId, 'AT_PLANNED_PATH_DECLARATION_MISSING', path, `unknown planned declaration or endpoint: ${obj.plannedPathDeclarationRef}:${obj.endpointRef}`);
      return [];
    }
    if (expectedPlannedRole && endpoint.role !== expectedPlannedRole) {
      pushDiagnostic(
        diagnostics,
        bindingId,
        'AT_PLANNED_PATH_DECLARATION_DRIFT',
        path,
        `planned endpoint ${endpoint.id} has role ${endpoint.role}; ${expectedPlannedRole} is required at this graph position`,
      );
    }
    return [obj.plannedPathDeclarationRef, obj.endpointRef];
  }
  pushDiagnostic(diagnostics, bindingId, 'AT_UNKNOWN_REF', path, `unsupported source ref kind: ${String(obj.refKind ?? '')}`);
  return [];
}

function arrayValue(obj: Record<string, unknown>, key: string): unknown[] {
  return Array.isArray(obj[key]) ? obj[key] as unknown[] : [];
}

function stableNodeArray(obj: Record<string, unknown>, key: string): unknown[] {
  return [...arrayValue(obj, key)].sort((left, right) => {
    const leftId = left && typeof left === 'object' && nonEmpty((left as Record<string, unknown>).id)
      ? String((left as Record<string, unknown>).id)
      : JSON.stringify(left);
    const rightId = right && typeof right === 'object' && nonEmpty((right as Record<string, unknown>).id)
      ? String((right as Record<string, unknown>).id)
      : JSON.stringify(right);
    return leftId.localeCompare(rightId);
  });
}

function collectAssertionRefs(assertion: unknown): { producerRefs: string[]; consumerRefs: string[] } {
  if (!assertion || typeof assertion !== 'object') return { producerRefs: [], consumerRefs: [] };
  const obj = assertion as Record<string, unknown>;
  return {
    producerRefs: Array.isArray(obj.producerRefs) ? obj.producerRefs.filter(nonEmpty) : [],
    consumerRefs: Array.isArray(obj.consumerRefs) ? obj.consumerRefs.filter(nonEmpty) : [],
  };
}

function diagnoseBinding(
  binding: ProofStoryAcceptanceBinding,
  canonicalRefs: ReadonlySet<string>,
  declarations: ReadonlyMap<string, VerificationPlannedPathDeclarationV1>,
  compatibilityMinimal: boolean,
  bindingIntents: readonly IntentIndexEntry[],
): { diagnostics: AcceptanceTopologyDiagnostic[]; declarationRefs: string[]; endpointRefs: string[] } {
  const diagnostics: AcceptanceTopologyDiagnostic[] = [];
  const declarationRefs: string[] = [];
  const endpointRefs: string[] = [];
  const topology = binding.verificationTopology as unknown;
  if (topology === undefined) return { diagnostics, declarationRefs, endpointRefs };
  if (!topology || typeof topology !== 'object') {
    pushDiagnostic(diagnostics, binding.id, 'AT_UNSUPPORTED_VERSION', 'verificationTopology', 'topology must be an object');
    return { diagnostics, declarationRefs, endpointRefs };
  }
  const obj = topology as Record<string, unknown>;
  if (obj.schemaVersion !== ACCEPTANCE_TOPOLOGY_SCHEMA_VERSION) {
    pushDiagnostic(diagnostics, binding.id, 'AT_UNSUPPORTED_VERSION', 'verificationTopology.schemaVersion', `unsupported topology version: ${String(obj.schemaVersion ?? '')}`);
  }
  for (const key of Object.keys(obj).sort()) {
    if (RESULT_KEYS.has(key)) pushDiagnostic(diagnostics, binding.id, 'AT_INLINE_RESULT_FORBIDDEN', `verificationTopology.${key}`, 'topology cannot store observed results or verdicts');
    else if (AUTHORITY_KEYS.has(key)) pushDiagnostic(diagnostics, binding.id, 'AT_AUTHORITY_PROMOTION_FORBIDDEN', `verificationTopology.${key}`, 'Wave 1 topology cannot store basis, authority, or freshness claims');
    else if (!TOPOLOGY_KEYS.has(key)) pushDiagnostic(diagnostics, binding.id, 'AT_PLANNED_PATH_DECLARATION_DRIFT', `verificationTopology.${key}`, 'topology is reference-only and cannot own edge semantics');
  }

  const producers = stableNodeArray(obj, 'producerRefs');
  const consumers = stableNodeArray(obj, 'consumerRefs');
  if (producers.length === 0) pushDiagnostic(diagnostics, binding.id, 'AT_ORPHAN_CONSUMER', 'verificationTopology.producerRefs', 'topology has no producer for its consumers or assertions');
  if (consumers.length === 0) pushDiagnostic(diagnostics, binding.id, 'AT_ORPHAN_PRODUCER', 'verificationTopology.consumerRefs', 'topology has no consumer for its producers or assertions');
  const groups = ['positiveAssertionRefs', 'mutationCaseRefs', 'transcriptAssertionRefs'] as const;
  const allNodes = [...producers, ...consumers, ...groups.flatMap(group => stableNodeArray(obj, group))];
  const ids = new Set<string>();
  for (const [index, node] of allNodes.entries()) {
    const id = node && typeof node === 'object' ? (node as Record<string, unknown>).id : undefined;
    if (!nonEmpty(id) || ids.has(id)) pushDiagnostic(diagnostics, binding.id, 'AT_DUPLICATE_ID', `verificationTopology.nodes[${index}].id`, `topology-local id is empty or duplicated: ${String(id ?? '')}`);
    else ids.add(id);
  }

  const producerIds = new Set<string>();
  for (const [index, producer] of producers.entries()) {
    const p = producer as Record<string, unknown>;
    if (nonEmpty(p?.id)) producerIds.add(p.id);
    const refs = validateSourceRef(p?.sourceRef, `verificationTopology.producerRefs[${index}].sourceRef`, binding.id, canonicalRefs, declarations, diagnostics, 'producer');
    if (p?.sourceRef && typeof p.sourceRef === 'object' && (p.sourceRef as Record<string, unknown>).refKind === 'planned') {
      if (refs[0]) declarationRefs.push(refs[0]);
      if (refs[1]) endpointRefs.push(refs[1]);
    }
  }

  const consumerIds = new Set<string>();
  const referencedProducers = new Set<string>();
  for (const [index, consumer] of consumers.entries()) {
    const c = consumer as Record<string, unknown>;
    if (nonEmpty(c?.id)) consumerIds.add(c.id);
    const producerRefs = Array.isArray(c?.producerRefs) ? c.producerRefs.filter(nonEmpty) : [];
    if (producerRefs.length === 0) pushDiagnostic(diagnostics, binding.id, 'AT_ORPHAN_CONSUMER', `verificationTopology.consumerRefs[${index}]`, 'consumer has no producer reference');
    for (const ref of producerRefs) {
      referencedProducers.add(ref);
      if (!producerIds.has(ref)) pushDiagnostic(diagnostics, binding.id, 'AT_UNKNOWN_REF', `verificationTopology.consumerRefs[${index}].producerRefs`, `unknown producer ref: ${ref}`);
    }
    const refs = validateSourceRef(c?.sourceRef, `verificationTopology.consumerRefs[${index}].sourceRef`, binding.id, canonicalRefs, declarations, diagnostics, 'consumer');
    if (c?.sourceRef && typeof c.sourceRef === 'object' && (c.sourceRef as Record<string, unknown>).refKind === 'planned') {
      if (refs[0]) declarationRefs.push(refs[0]);
      if (refs[1]) endpointRefs.push(refs[1]);
    }
  }
  for (const id of producerIds) if (!referencedProducers.has(id)) pushDiagnostic(diagnostics, binding.id, 'AT_ORPHAN_PRODUCER', 'verificationTopology.producerRefs', `producer has no consumer: ${id}`);

  const intentMappings = new Map<typeof groups[number], Set<string>>();
  for (const group of groups) {
    const assertions = stableNodeArray(obj, group);
    const mappedIntentRefs = new Set<string>();
    intentMappings.set(group, mappedIntentRefs);
    const required = group === 'positiveAssertionRefs' || !compatibilityMinimal;
    const missingCode = group === 'mutationCaseRefs' ? 'AT_MUTATION_MISSING' : group === 'transcriptAssertionRefs' ? 'AT_TRANSCRIPT_MISSING' : 'AT_INTENT_UNCOVERED';
    if (required && assertions.length === 0) pushDiagnostic(diagnostics, binding.id, missingCode, `verificationTopology.${group}`, `${group} is required`);
    for (const [index, assertion] of assertions.entries()) {
      const a = assertion as Record<string, unknown>;
      validateSourceRef(a?.sourceRef, `verificationTopology.${group}[${index}].sourceRef`, binding.id, canonicalRefs, declarations, diagnostics);
      const sourceRef = a?.sourceRef && typeof a.sourceRef === 'object'
        ? a.sourceRef as Record<string, unknown>
        : undefined;
      if (sourceRef?.refKind === 'existing' && nonEmpty(sourceRef.canonicalSourceRef) && sourceRef.canonicalSourceRef.startsWith('intent:')) {
        mappedIntentRefs.add(sourceRef.canonicalSourceRef.slice('intent:'.length));
      }
      const refs = collectAssertionRefs(assertion);
      refs.producerRefs.filter(ref => !producerIds.has(ref)).forEach(ref => pushDiagnostic(diagnostics, binding.id, 'AT_UNKNOWN_REF', `verificationTopology.${group}[${index}].producerRefs`, `unknown producer ref: ${ref}`));
      refs.consumerRefs.filter(ref => !consumerIds.has(ref)).forEach(ref => pushDiagnostic(diagnostics, binding.id, 'AT_UNKNOWN_REF', `verificationTopology.${group}[${index}].consumerRefs`, `unknown consumer ref: ${ref}`));
    }
  }

  const commandRefs = [...arrayValue(obj, 'commandRefs')].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  if (!compatibilityMinimal && commandRefs.length === 0) {
    pushDiagnostic(diagnostics, binding.id, 'AT_COMMAND_MISSING', 'verificationTopology.commandRefs', 'at least one canonical command reference is required');
  }
  for (const [index, commandRef] of commandRefs.entries()) {
    validateSourceRef(commandRef, `verificationTopology.commandRefs[${index}]`, binding.id, canonicalRefs, declarations, diagnostics);
  }
  for (const entry of bindingIntents.filter(candidate => (candidate.intent.priority ?? 'must') === 'must')) {
    const mapped = compatibilityMinimal
      ? intentMappings.get('positiveAssertionRefs')?.has(entry.intentRef)
      : entry.lane === 'happy'
      ? intentMappings.get('positiveAssertionRefs')?.has(entry.intentRef)
      : entry.lane === 'edge'
        ? intentMappings.get('positiveAssertionRefs')?.has(entry.intentRef)
          || intentMappings.get('mutationCaseRefs')?.has(entry.intentRef)
        : intentMappings.get('mutationCaseRefs')?.has(entry.intentRef);
    if (!mapped) {
      pushDiagnostic(
        diagnostics,
        binding.id,
        'AT_INTENT_UNCOVERED',
        `verificationIntentRefs.${entry.intentRef}`,
        `must ${entry.lane} verification intent ${entry.intentRef} is not mapped by an appropriate assertion group`,
      );
    }
  }
  return { diagnostics, declarationRefs: stableUnique(declarationRefs), endpointRefs: stableUnique(endpointRefs) };
}

export function buildAcceptanceMatrixReport(args: {
  storyId: string;
  checklist: ChecklistData;
  contract: ProofStoryContractData | null;
  ledger: MilestoneLedgerData | null;
}): AcceptanceMatrixReport {
  const bindings = [...(args.contract?.acceptanceBindings ?? [])].sort((a, b) => a.id.localeCompare(b.id));
  const intents = indexIntents(args.checklist);
  const intentsByRef = new Map(intents.map(entry => [entry.intentRef, entry]));
  const declarations = plannedDeclarationIndex(intents);
  const canonicalRefs = canonicalSourceRefs(bindings, args.checklist, args.ledger, intents);
  const diagnostics: AcceptanceTopologyDiagnostic[] = [];
  const rows: AcceptanceMatrixRow[] = [];
  for (const binding of bindings) {
    const docsOnly = binding.verificationIntentRefs.length > 0
      && binding.verificationIntentRefs.every(ref => intentsByRef.get(ref)?.intent.type === 'docs');
    const bindingIntents = binding.verificationIntentRefs
      .map(ref => intentsByRef.get(ref))
      .filter((entry): entry is IntentIndexEntry => entry !== undefined);
    const singleOutcome = bindingIntents.length === 1;
    const diagnosed = diagnoseBinding(binding, canonicalRefs, declarations, docsOnly || singleOutcome, bindingIntents);
    for (const ref of binding.checklistRefs) {
      if (!canonicalRefs.has(`checklist:${ref}`)) pushDiagnostic(diagnosed.diagnostics, binding.id, 'AT_UNKNOWN_REF', 'checklistRefs', `unknown checklist ref: ${ref}`);
    }
    for (const ref of binding.verificationIntentRefs) {
      if (!canonicalRefs.has(`intent:${ref}`)) pushDiagnostic(diagnosed.diagnostics, binding.id, 'AT_UNKNOWN_REF', 'verificationIntentRefs', `unknown verification intent ref: ${ref}`);
    }
    for (const ref of binding.milestoneIds) {
      if (!canonicalRefs.has(`milestone:${ref}`)) pushDiagnostic(diagnosed.diagnostics, binding.id, 'AT_UNKNOWN_REF', 'milestoneIds', `unknown milestone ref: ${ref}`);
    }
    diagnosed.diagnostics.sort((a, b) => `${a.code}\0${a.path}\0${a.message}`.localeCompare(`${b.code}\0${b.path}\0${b.message}`));
    diagnostics.push(...diagnosed.diagnostics);
    const itemRefs = stableUnique(binding.checklistRefs.map(ref => `checklist:${ref}`));
    const intentRefs = stableUnique(binding.verificationIntentRefs.map(ref => `intent:${ref}`));
    const evidenceRefs = stableUnique(args.checklist.items.flatMap(item =>
      (item.verificationEvidence ?? [])
        .map((evidence, index) => ({ evidence, index }))
        .filter(({ evidence }) => binding.verificationIntentRefs.includes(evidence.intentRef))
        .map(({ evidence, index }) => `evidence:${item.id}:${evidence.intentRef}:${index}`)));
    const topologyState = binding.verificationTopology === undefined ? 'legacy_missing' as const : 'configured' as const;
    rows.push({
      acceptanceBindingRef: `acceptance-binding:${binding.id}`,
      checklistRefs: itemRefs,
      verificationIntentRefs: intentRefs,
      milestoneRefs: stableUnique(binding.milestoneIds.map(ref => `milestone:${ref}`)),
      plannedPathDeclarationRefs: diagnosed.declarationRefs,
      endpointRefs: diagnosed.endpointRefs,
      evidenceRefs,
      topologyState,
      result: topologyState === 'legacy_missing' ? 'legacy_missing' : diagnosed.diagnostics.length > 0 ? 'warning' : 'inconclusive_basis_unverified',
      diagnosticCodes: stableUnique(diagnosed.diagnostics.map(diagnostic => diagnostic.code)),
    });
  }
  diagnostics.sort((a, b) => `${a.bindingId}\0${a.code}\0${a.path}\0${a.message}`.localeCompare(`${b.bindingId}\0${b.code}\0${b.path}\0${b.message}`));
  const states = new Set(rows.map(row => row.topologyState));
  const topologyState = states.size > 1 ? 'mixed' as const : rows[0]?.topologyState ?? 'legacy_missing' as const;
  const result: AcceptanceTopologyResult = rows.some(row => row.result === 'warning')
    ? 'warning'
    : rows.some(row => row.result === 'inconclusive_basis_unverified')
      ? 'inconclusive_basis_unverified'
      : 'legacy_missing';
  return { storyId: args.storyId, mode: 'observe', readOnly: true, evidentiary: false, topologyState, result, rows, diagnostics };
}

/**
 * Canonical Wave 2 structural evaluator. The production adapter supplies the
 * verifier-derived receipt result; this function derives every pass/blocking
 * field and never reads executable evidence or caller-provided verdicts.
 */
export function evaluateAcceptanceTopologyCheck(args: {
  storyId: string;
  mode: AcceptanceTopologyGateMode;
  checklist: ChecklistData;
  contract: ProofStoryContractData | null;
  ledger: MilestoneLedgerData | null;
  artifact: AcceptanceBasisArtifactV1 | null;
  receiptVerification: AcceptanceBasisReceiptVerification;
  currentBasisDiagnostics: readonly AcceptanceBasisDiagnostic[];
  topologyBasisDiagnostics: readonly AcceptanceBasisDiagnostic[];
}): AcceptanceTopologyCheckReport {
  const matrix = buildAcceptanceMatrixReport({
    storyId: args.storyId,
    checklist: args.checklist,
    contract: args.contract,
    ledger: args.ledger,
  });
  const diagnostics: AcceptanceTopologyDiagnostic[] = [...matrix.diagnostics];
  const bindings = args.contract?.acceptanceBindings ?? [];
  if (bindings.length === 0) {
    diagnostics.push({
      code: 'AT_MISSING_TOPOLOGY', bindingId: '<story>', path: 'proofstory.acceptanceBindings',
      message: 'no required acceptance binding supplies a topology',
    });
  }
  for (const row of matrix.rows.filter(candidate => candidate.topologyState === 'legacy_missing')) {
    diagnostics.push({
      code: 'AT_MISSING_TOPOLOGY',
      bindingId: row.acceptanceBindingRef.replace(/^acceptance-binding:/, ''),
      path: 'verificationTopology',
      message: 'required acceptance binding has no topology; legacy data remains readable but is not structurally complete',
    });
  }

  const basisStatus = args.artifact?.basis.status ?? 'missing';
  if (!args.artifact) {
    diagnostics.push({
      code: 'AT_COVERAGE_BASIS_MISSING', bindingId: '<story>', path: 'acceptance-basis.json',
      message: 'registered verifier-produced PLAN coverage basis is missing',
    });
  } else {
    if (args.artifact.schemaVersion !== 'proofstory.acceptance_basis_artifact.v1') {
      diagnostics.push({
        code: 'AT_ADAPTER_RESULT_DIGEST_MISMATCH', bindingId: '<story>', path: 'acceptance-basis.json.schemaVersion',
        message: 'acceptance basis artifact schema is invalid',
      });
    }
    if (basisStatus === 'partial' || basisStatus === 'unsupported') {
      diagnostics.push({
        code: 'AT_COVERAGE_BASIS_PARTIAL', bindingId: '<story>', path: 'acceptance-basis.json.basis.status',
        message: `coverage basis is ${basisStatus}; structural completeness is inconclusive`,
      });
    }
  }
  if (!args.receiptVerification.ok) {
    diagnostics.push({
      code: args.receiptVerification.code,
      bindingId: '<story>',
      path: 'acceptance-basis.json.receipt',
      message: args.receiptVerification.diagnostics.join('; ') || 'coverage basis receipt verification failed',
    });
    // The receipt verifier includes independently derived basis diagnostics as
    // stable `AT_*: message` entries. Preserve those machine codes instead of
    // collapsing every adapter/aggregate failure into the receipt summary.
    for (const message of args.receiptVerification.diagnostics) {
      const match = /^(AT_[A-Z0-9_]+):\s*(.*)$/.exec(message);
      if (match) diagnostics.push({
        code: match[1],
        bindingId: '<story>',
        path: 'acceptance-basis.json.basis',
        message: match[2] || message,
      });
    }
  }
  for (const item of [...args.currentBasisDiagnostics, ...args.topologyBasisDiagnostics]) {
    diagnostics.push({
      code: item.code,
      bindingId: '<story>',
      path: item.pathRef ?? 'acceptance-basis.json',
      message: item.message,
    });
  }

  const orderedDiagnostics = stableDiagnostics(diagnostics);
  const structuralPass = basisStatus === 'complete' && args.receiptVerification.ok && orderedDiagnostics.length === 0;
  const blocking = args.mode === 'enforce' && !structuralPass;
  const inconclusive = basisStatus === 'missing' || basisStatus === 'partial' || basisStatus === 'unsupported';
  const status: AcceptanceTopologyCheckReport['status'] = structuralPass
    ? 'pass'
    : inconclusive ? 'inconclusive' : 'fail';
  return {
    storyId: args.storyId,
    mode: args.mode,
    readOnly: true,
    evidentiary: false,
    authority: 'diagnostic_only',
    status,
    structuralPass,
    blocking,
    basisStatus,
    topologyState: matrix.topologyState,
    rows: matrix.rows,
    diagnostics: orderedDiagnostics,
    nextAction: structuralPass
      ? 'Structural topology is complete for PLAN; continue the configured lifecycle transition.'
      : 'Repair the named AT_* structural diagnostics, regenerate the verifier-owned PLAN basis, and rerun acceptance_topology_check.',
  };
}
