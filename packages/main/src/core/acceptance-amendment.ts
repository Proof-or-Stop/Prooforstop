/** Additive acceptance derivation. This module never approves or persists a proposal. */
import type { ChecklistData, ChecklistItem, ProofStoryAcceptanceBinding, ProofStoryContractData, ScopeContractData, VerificationIntent } from './types.js';
import { collectVerificationIntents } from './verification.js';
import { validatePaths } from './scope-contract.js';
import { normalizeScopePath, pathMatchesScopePattern } from './scope-path-classifier.js';
import { buildAcceptanceMatrixReport, validatePlannedPathDeclarationsForChecklistItem } from './acceptance-topology.js';

export interface AcceptanceAmendmentSnapshot {
  storyId: string;
  checklist: ChecklistData;
  scope: ScopeContractData;
  proofStory: ProofStoryContractData;
}
export interface AcceptanceAmendmentDelta {
  addItems: Array<Pick<ChecklistItem, 'id' | 'title' | 'context' | 'userSees' | 'relatedDocs' | 'excludes' | 'files' | 'verificationIntent'>>;
  appendIntents: Array<{ itemId: string; verificationIntent: VerificationIntent; filesDelta?: { modify: string[]; create: string[]; test: string[] } }>;
  scopeDelta: { modify: string[]; create: string[]; test: string[] };
  topologyDelta: ProofStoryAcceptanceBinding[];
}

const lanes = ['happy', 'edge', 'adversarial'] as const;
const fileKinds = ['modify', 'create', 'test'] as const;
function exactFields(value: unknown, allowed: readonly string[], label: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label}: expected an additive object`);
  const unknown = Object.keys(value).filter(k => !allowed.includes(k));
  if (unknown.length) throw new Error(`${label}: unknown fields or non-additive operation: ${unknown.join(', ')}`);
}
function literalPaths(values: unknown, label: string): string[] {
  return validatePaths(values, label).map(path => {
    // A delta grants only exact reviewed files, never a newly widened glob.
    if (/^[A-Za-z]:/.test(path) || /[\x00-\x1f\x7f]/.test(path) || /[*?[\]{}]/.test(path) || path.split(/[\\/]/).some(p => p === '..') || /%(?:2e|2f|5c)/i.test(path)) throw new Error(`${label}: unsafe or nonliteral scope path`);
    return normalizeScopePath(path);
  });
}

export function deriveAcceptanceAmendment(base: AcceptanceAmendmentSnapshot, delta: AcceptanceAmendmentDelta): AcceptanceAmendmentSnapshot {
  exactFields(delta, ['addItems', 'appendIntents', 'scopeDelta', 'topologyDelta'], 'amendment');
  if (!Array.isArray(delta.addItems) || !Array.isArray(delta.appendIntents) || !Array.isArray(delta.topologyDelta)) throw new Error('amendment requires additive item, intent and topology arrays');
  exactFields(delta.scopeDelta, fileKinds, 'scopeDelta');
  if (!base.scope || !base.proofStory || base.scope.storyId !== base.storyId || base.proofStory.storyId !== base.storyId) throw new Error('amendment requires the current Story scope and acceptance contracts');
  const next = structuredClone(base);
  const touched = new Set<string>();
  const addedRefs = new Set<string>();
  const allRefs = new Set<string>();
  for (const item of base.checklist.items) for (const intent of collectVerificationIntents(item)) {
    if (allRefs.has(intent.ref)) throw new Error(`duplicate existing intent ${intent.ref}`);
    allRefs.add(intent.ref);
  }
  const append = (item: ChecklistItem, addition: VerificationIntent) => {
    exactFields(addition, lanes, 'verificationIntent');
    if (!lanes.every(lane => Array.isArray(addition[lane])) || lanes.every(lane => addition[lane].length === 0)) throw new Error('amendment requires new required verification intents');
    const before = collectVerificationIntents(item).length;
    item.verificationIntent ??= { happy: [], edge: [], adversarial: [] };
    for (const lane of lanes) for (const intent of addition[lane]) {
      exactFields(intent, ['id', 'desc', 'type', 'priority', 'requiredIn', 'plannedPathDeclarations'], 'new intent');
      if (typeof intent.desc !== 'string' || !intent.desc.trim() || !['logic', 'cli', 'browser', 'manual', 'docs'].includes(intent.type)
        || (intent.priority !== undefined && intent.priority !== 'must') || intent.requiredIn !== undefined) throw new Error('new amendment intents must be required without phase exclusions');
      item.verificationIntent[lane] ??= [];
      const ref = intent.id || `${item.id}:${lane}:${item.verificationIntent[lane].length}`;
      if (allRefs.has(ref)) throw new Error(`duplicate intent ${ref}`);
      allRefs.add(ref); addedRefs.add(ref);
      item.verificationIntent[lane].push(structuredClone(intent));
    }
    if (collectVerificationIntents(item).length === before) throw new Error('amendment adds no intent');
    validatePlannedPathDeclarationsForChecklistItem(item, item.verificationIntent);
    item.status = 'pending';
    item.endTime = null;
    touched.add(item.id);
  };
  for (const addition of delta.addItems) {
    exactFields(addition, ['id', 'title', 'context', 'userSees', 'relatedDocs', 'excludes', 'files', 'verificationIntent'], 'new item');
    if (!addition.id?.trim() || next.checklist.items.some(i => i.id === addition.id)) throw new Error('new item has an existing or duplicate ID');
    if (!addition.title?.trim() || !addition.verificationIntent) throw new Error('new item requires title and verificationIntent');
    const item: ChecklistItem = { ...structuredClone(addition), status: 'pending', startTime: null, endTime: null, verificationIntent: { happy: [], edge: [], adversarial: [] } };
    append(item, addition.verificationIntent);
    next.checklist.items.push(item);
  }
  for (const addition of delta.appendIntents) {
    exactFields(addition, ['itemId', 'verificationIntent', 'filesDelta'], 'appendIntents');
    const item = next.checklist.items.find(i => i.id === addition.itemId);
    if (!item || item.status === 'withdrawn' || touched.has(item.id)) throw new Error('intent target is missing, withdrawn or duplicated');
    if (addition.filesDelta) {
      exactFields(addition.filesDelta, fileKinds, 'filesDelta');
      const files = { modify: [...(item.files?.modify ?? [])], create: [...(item.files?.create ?? [])], test: [...(item.files?.test ?? [])] };
      for (const kind of fileKinds) for (const path of literalPaths(addition.filesDelta[kind], `filesDelta.${kind}`)) {
        if (!files[kind].includes(path)) files[kind].push(path);
      }
      item.files = files;
    }
    append(item, addition.verificationIntent);
  }
  if (addedRefs.size === 0) throw new Error('amendment must add acceptance requirements');
  const declared = { modify: new Set<string>(), create: new Set<string>(), test: new Set<string>() };
  for (const item of next.checklist.items.filter(i => touched.has(i.id))) {
    if (!item.files) throw new Error(`amended item ${item.id} requires explicit Story file scope`);
    exactFields(item.files, fileKinds, 'item.files');
    for (const kind of fileKinds) for (const path of literalPaths(item.files[kind], `item.files.${kind}`)) declared[kind].add(path);
    if (fileKinds.every(kind => (item.files?.[kind]?.length ?? 0) === 0)) throw new Error('amended item has no scoped files');
  }
  for (const kind of fileKinds) {
    const key = { modify: 'allowedModify', create: 'allowedCreate', test: 'allowedTest' }[kind] as 'allowedModify' | 'allowedCreate' | 'allowedTest';
    for (const path of literalPaths(delta.scopeDelta[kind], `scopeDelta.${kind}`)) {
      if ([...base.scope.protectedFiles, ...base.scope.explicitExcludes].some(pattern => pathMatchesScopePattern(path, pattern))) throw new Error(`scope delta touches protected or excluded file ${path}`);
      if (!declared[kind].has(path)) throw new Error(`scope delta ${path} has no amended item relationship`);
      if (!next.scope[key].includes(path)) next.scope[key].push(path);
    }
    for (const path of declared[kind]) {
      if ([...base.scope.protectedFiles, ...base.scope.explicitExcludes].some(pattern => pathMatchesScopePattern(path, pattern))) throw new Error(`amended item touches protected or excluded file ${path}`);
      if (!next.scope[key].some(pattern => pathMatchesScopePattern(path, pattern))) throw new Error(`amended item file ${path} is outside approved scope delta`);
    }
  }
  const bindingIds = new Set(next.proofStory.acceptanceBindings.map(b => b.id));
  const covered = new Set<string>();
  for (const binding of delta.topologyDelta) {
    exactFields(binding, ['id', 'acceptanceClaim', 'checklistRefs', 'verificationIntentRefs', 'milestoneIds', 'note', 'verificationTopology'], 'topology binding');
    if (!binding.id?.trim() || bindingIds.has(binding.id)) throw new Error('duplicate topology binding');
    if (!binding.verificationTopology || !binding.verificationIntentRefs?.some(ref => addedRefs.has(ref))) throw new Error('topology binding must describe new verification intent');
    for (const ref of binding.verificationIntentRefs) {
      const owner = next.checklist.items.find(item => collectVerificationIntents(item).some(i => i.ref === ref));
      if (!owner || !binding.checklistRefs.includes(owner.id)) throw new Error(`topology binding has unrelated intent ${ref}`);
      covered.add(ref);
    }
    bindingIds.add(binding.id);
    next.proofStory.acceptanceBindings.push(structuredClone(binding));
  }
  if ([...addedRefs].some(ref => !covered.has(ref))) throw new Error('new intent lacks an additive topology binding');
  const matrix = buildAcceptanceMatrixReport({ storyId: base.storyId, checklist: next.checklist, contract: next.proofStory, ledger: null });
  const newIds = new Set(delta.topologyDelta.map(b => b.id));
  const defects = matrix.diagnostics.filter(d => newIds.has(d.bindingId));
  if (defects.length) throw new Error(`invalid amendment topology: ${defects.map(d => d.code).join(', ')}`);
  return next;
}
