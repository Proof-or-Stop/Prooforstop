import type {
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

export function verificationIntentHasPlannedPathDeclarations(intent: VerificationIntent | undefined): boolean {
  if (!intent) return false;
  return (['happy', 'edge', 'adversarial'] as const).some(lane =>
    (intent[lane] ?? []).some(item => (item.plannedPathDeclarations?.length ?? 0) > 0));
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
  const normalizedFile = endpoint.expectedFileRef.replace(/\\/g, '/');
  if (normalizedFile.startsWith('/') || /^[A-Za-z]:\//.test(normalizedFile) || normalizedFile.split('/').includes('..')) {
    throw new Error(`${base}.expectedFileRef must be a safe repository-relative path [planned_path_file_ref_unsafe]`);
  }
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

interface IntentIndexEntry {
  itemId: string;
  intentRef: string;
  intent: VerificationIntentItem;
}

function indexIntents(checklist: ChecklistData): IntentIndexEntry[] {
  const result: IntentIndexEntry[] = [];
  for (const item of checklist.items) {
    for (const lane of ['happy', 'edge', 'adversarial'] as const) {
      for (const [index, intent] of (item.verificationIntent?.[lane] ?? []).entries()) {
        result.push({ itemId: item.id, intentRef: intent.id || `${item.id}:${lane}:${index}`, intent });
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
  return refs;
}

function pushDiagnostic(
  diagnostics: AcceptanceTopologyDiagnostic[], bindingId: string, code: string, path: string, message: string,
): void {
  diagnostics.push({ code, bindingId, path, message });
}

function validateSourceRef(
  ref: unknown,
  path: string,
  bindingId: string,
  canonicalRefs: ReadonlySet<string>,
  declarations: ReadonlyMap<string, VerificationPlannedPathDeclarationV1>,
  diagnostics: AcceptanceTopologyDiagnostic[],
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
    if (!nonEmpty(obj.canonicalSourceRef) || !canonicalRefs.has(obj.canonicalSourceRef)) {
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
    if (!declaration || !endpoints.some(endpoint => endpoint.id === obj.endpointRef)) {
      pushDiagnostic(diagnostics, bindingId, 'AT_PLANNED_PATH_DECLARATION_MISSING', path, `unknown planned declaration or endpoint: ${obj.plannedPathDeclarationRef}:${obj.endpointRef}`);
      return [];
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
  docsOnly: boolean,
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
    const refs = validateSourceRef(p?.sourceRef, `verificationTopology.producerRefs[${index}].sourceRef`, binding.id, canonicalRefs, declarations, diagnostics);
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
    const refs = validateSourceRef(c?.sourceRef, `verificationTopology.consumerRefs[${index}].sourceRef`, binding.id, canonicalRefs, declarations, diagnostics);
    if (c?.sourceRef && typeof c.sourceRef === 'object' && (c.sourceRef as Record<string, unknown>).refKind === 'planned') {
      if (refs[0]) declarationRefs.push(refs[0]);
      if (refs[1]) endpointRefs.push(refs[1]);
    }
  }
  for (const id of producerIds) if (!referencedProducers.has(id)) pushDiagnostic(diagnostics, binding.id, 'AT_ORPHAN_PRODUCER', 'verificationTopology.producerRefs', `producer has no consumer: ${id}`);

  for (const group of groups) {
    const assertions = stableNodeArray(obj, group);
    const required = group === 'positiveAssertionRefs' || !docsOnly;
    const missingCode = group === 'mutationCaseRefs' ? 'AT_MUTATION_MISSING' : group === 'transcriptAssertionRefs' ? 'AT_TRANSCRIPT_MISSING' : 'AT_INTENT_UNCOVERED';
    if (required && assertions.length === 0) pushDiagnostic(diagnostics, binding.id, missingCode, `verificationTopology.${group}`, `${group} is required`);
    for (const [index, assertion] of assertions.entries()) {
      const a = assertion as Record<string, unknown>;
      validateSourceRef(a?.sourceRef, `verificationTopology.${group}[${index}].sourceRef`, binding.id, canonicalRefs, declarations, diagnostics);
      const refs = collectAssertionRefs(assertion);
      refs.producerRefs.filter(ref => !producerIds.has(ref)).forEach(ref => pushDiagnostic(diagnostics, binding.id, 'AT_UNKNOWN_REF', `verificationTopology.${group}[${index}].producerRefs`, `unknown producer ref: ${ref}`));
      refs.consumerRefs.filter(ref => !consumerIds.has(ref)).forEach(ref => pushDiagnostic(diagnostics, binding.id, 'AT_UNKNOWN_REF', `verificationTopology.${group}[${index}].consumerRefs`, `unknown consumer ref: ${ref}`));
    }
  }

  const commandRefs = [...arrayValue(obj, 'commandRefs')].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  for (const [index, commandRef] of commandRefs.entries()) {
    validateSourceRef(commandRef, `verificationTopology.commandRefs[${index}]`, binding.id, canonicalRefs, declarations, diagnostics);
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
    const diagnosed = diagnoseBinding(binding, canonicalRefs, declarations, docsOnly);
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
