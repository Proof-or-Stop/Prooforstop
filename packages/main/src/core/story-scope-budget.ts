/** Semantic scope accounting. No file-count proxy and no approval side effects. */
import { canonicalDigest } from './authority-signing.js';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadConfig, pickProjectConfigPath, type ProofOrStopConfig } from './config.js';
import { COMMAND_POLICIES } from './command-policy.js';
import { PROCESS_FACT_REGISTRY } from './process-fact-registry.js';
import { CANONICAL_REVIEW_HOSTS } from './host-execution-readiness.js';
import { collectVerificationIntents } from './verification.js';
import { canonicalFilesystemPath } from './keyed-scheduler.js';
import { readScopeDecomposition, type ScopeDecompositionReport } from './story-scope-decomposition.js';
import { currentScopeBudgetApproval } from './story-scope-budget-decisions.js';
import { isMalformedScopeGlob, pathMatchesScopePattern } from './scope-path-classifier.js';
import type { StoryStore } from './store.js';
import type { ChecklistData, ProofStoryContractData, ScopeContractData } from './types.js';

export const SCOPE_BUDGET_DIMENSIONS = [
  'responsibilityDomains', 'hostAdapters', 'processFacts', 'publicCommands',
  'acceptanceTopology', 'devScopeDelta', 'validationGroups',
] as const;
export type ScopeBudgetDimension = typeof SCOPE_BUDGET_DIMENSIONS[number];
export interface StoryScopeBudgetPolicy {
  schemaVersion: 'story-scope-budget.v1';
  mode: 'observe' | 'enforce';
  limits: Record<ScopeBudgetDimension, number>;
  responsibilities: Array<{ id: string; paths: string[]; hostAdapters: string[]; validationGroups: string[] }>;
  /** Explicit grouping of registered validation command labels; focus is not a domain. */
  validationGroups?: Array<{ id: string; commandLabels: string[] }>;
}
export interface ScopeBudgetSubject {
  storyId: string;
  scope: ScopeContractData;
  checklist: ChecklistData;
  proofStory: ProofStoryContractData;
}
export interface StoryScopeBudgetReport {
  schemaVersion: 'story-scope-budget-report.v1';
  storyId: string;
  mode: 'disabled' | 'observe' | 'enforce';
  status: 'disabled' | 'within_budget' | 'decision_required' | 'approved_large_story' | 'unknown';
  blocking: boolean;
  counts: Record<ScopeBudgetDimension, number>;
  facts: Record<ScopeBudgetDimension, string[]>;
  exceeded: ScopeBudgetDimension[];
  diagnostics: string[];
  bindingDigest: string;
  paths: string[];
  decomposition?: ScopeDecompositionReport;
}
const emptyFacts = (): Record<ScopeBudgetDimension, string[]> => Object.fromEntries(
  SCOPE_BUDGET_DIMENSIONS.map(key => [key, [] as string[]]),
) as Record<ScopeBudgetDimension, string[]>;
const unique = (values: string[]) => [...new Set(values)].sort();
const names = (value: unknown, label: string): string[] => {
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || !item.trim() || item !== item.trim())) {
    throw new Error(`scope budget ${label} requires nonempty string identities`);
  }
  return unique(value);
};
function policyFor(value: unknown): StoryScopeBudgetPolicy {
  const policy = value as StoryScopeBudgetPolicy;
  if (!policy || policy.schemaVersion !== 'story-scope-budget.v1' || !['observe', 'enforce'].includes(policy.mode)) {
    throw new Error('scope budget policy schema or mode is invalid');
  }
  for (const key of SCOPE_BUDGET_DIMENSIONS) {
    if (!Number.isSafeInteger(policy.limits?.[key]) || policy.limits[key] < 0) throw new Error(`scope budget limit ${key} must be a nonnegative integer`);
  }
  if (!Array.isArray(policy.responsibilities) || !policy.responsibilities.length) throw new Error('scope budget requires an explicit responsibility map');
  const ids = new Set<string>();
  for (const row of policy.responsibilities) {
    if (!row || typeof row.id !== 'string' || !row.id.trim() || ids.has(row.id)) throw new Error('scope budget responsibility identity is missing or duplicated');
    ids.add(row.id);
    const paths = names(row.paths, `${row.id}.paths`);
    if (!paths.length || paths.some(path => path.startsWith('/') || path.split(/[\\/]/).includes('..') || isMalformedScopeGlob(path))) {
      throw new Error(`scope budget ${row.id} has invalid path patterns`);
    }
    if (names(row.hostAdapters, `${row.id}.hostAdapters`).some(host => !(CANONICAL_REVIEW_HOSTS as readonly string[]).includes(host))) {
      throw new Error(`scope budget ${row.id} references an unregistered host adapter`);
    }
    names(row.validationGroups, `${row.id}.validationGroups`);
  }
  return policy;
}

// Stable registry identities are indexed by their implementing/consuming source,
// never by the number of declarations in the registry file itself.
const factsBySource = new Map<string, Array<{ name: string; command: boolean }>>();
for (const fact of PROCESS_FACT_REGISTRY) {
  const ownerModule = /^(?:core|handlers)\/[A-Za-z0-9_/-]+$/.test(fact.producer)
    ? [`packages/main/src/${fact.producer}.ts`] : [];
  for (const source of unique([...ownerModule, ...(fact.producerSourceRefs ?? []), ...(fact.consumerSourceRefs ?? [])])) {
    const path = source.split('#')[0]!;
    factsBySource.set(path, [...(factsBySource.get(path) ?? []), { name: fact.name, command: Object.hasOwn(COMMAND_POLICIES, fact.name) }]);
  }
}
const sourcePath = (path: string) => path.replace(/\\/g, '/').replace(/^\.\//, '');
function subjectFacts(subject: ScopeBudgetSubject, policy: StoryScopeBudgetPolicy, config: ProofOrStopConfig) {
  if (!subject.scope || subject.scope.storyId !== subject.storyId || !Array.isArray(subject.checklist?.items)
    || !subject.proofStory || subject.proofStory.storyId !== subject.storyId || !Array.isArray(subject.proofStory.acceptanceBindings)) {
    throw new Error('scope budget requires current scope, checklist and acceptance topology');
  }
  const facts = emptyFacts();
  const diagnostics: string[] = [];
  const paths = unique([
    ...names(subject.scope.allowedModify, 'allowedModify'), ...names(subject.scope.allowedCreate, 'allowedCreate'),
    ...names(subject.scope.allowedTest, 'allowedTest'),
    ...subject.checklist.items.filter(item => item.status !== 'withdrawn').flatMap(item =>
      ['modify', 'create', 'test'].flatMap(kind => names(item.files?.[kind as 'modify'] ?? [], `checklist.${kind}`))),
  ].map(sourcePath));
  const commands = config.validate?.commands ?? config.validation?.commands ?? [];
  const commandLabels = new Set(commands.map(command => typeof command === 'string' ? command : command.label ?? command.command));
  const groups = new Map<string, string[]>();
  for (const group of policy.validationGroups ?? []) {
    if (!group?.id?.trim() || groups.has(group.id)) throw new Error('scope budget validation group identity is missing or duplicated');
    const labels = names(group.commandLabels, `${group.id}.commandLabels`);
    if (!labels.length || labels.some(label => !commandLabels.has(label))) throw new Error(`scope budget validation group ${group.id} references an unregistered command`);
    groups.set(group.id, labels);
  }
  for (const path of paths) {
    if (!path || path.startsWith('/') || /^[A-Za-z]:/.test(path) || path.split('/').includes('..') || /[*?[\]{}\x00-\x1f]/.test(path)) {
      diagnostics.push(`unresolved scope path: ${path}`); continue;
    }
    const rows = policy.responsibilities.filter(row => row.paths.some(pattern => pathMatchesScopePattern(path, pattern)));
    if (!rows.length) diagnostics.push(`unmapped responsibility: ${path}`);
    for (const row of rows) {
      facts.responsibilityDomains.push(row.id);
      facts.hostAdapters.push(...row.hostAdapters);
      for (const group of row.validationGroups) {
        if (!groups.has(group)) diagnostics.push(`unregistered validation group: ${group}`);
        else facts.validationGroups.push(group);
      }
    }
    for (const fact of factsBySource.get(path) ?? []) {
      facts.processFacts.push(fact.name);
      if (fact.command) facts.publicCommands.push(fact.name);
    }
  }
  const bindingIds = new Set<string>();
  const recordProcessRef = (ref: { refKind: string; canonicalSourceRef?: string }) => {
    if (ref.refKind !== 'existing' || !ref.canonicalSourceRef?.startsWith('process-fact:')) return;
    const name = ref.canonicalSourceRef.slice('process-fact:'.length);
    const fact = PROCESS_FACT_REGISTRY.find(row => row.name === name);
    if (!fact) diagnostics.push(`unregistered process fact: ${name}`);
    else { facts.processFacts.push(name); if (Object.hasOwn(COMMAND_POLICIES, name)) facts.publicCommands.push(name); }
  };
  for (const binding of subject.proofStory.acceptanceBindings) {
    if (!binding.id?.trim() || bindingIds.has(binding.id)) { diagnostics.push('missing or duplicate acceptance binding identity'); continue; }
    bindingIds.add(binding.id);
    const topology = binding.verificationTopology;
    if (!topology) { diagnostics.push(`missing acceptance topology: ${binding.id}`); continue; }
    facts.acceptanceTopology.push(`${binding.id}:binding`);
    for (const kind of ['producerRefs', 'consumerRefs', 'positiveAssertionRefs', 'mutationCaseRefs', 'transcriptAssertionRefs'] as const) {
      if (!Array.isArray(topology[kind])) { diagnostics.push(`invalid topology ${binding.id}.${kind}`); continue; }
      const nodeIds = new Set<string>();
      for (const node of topology[kind]) {
        if (!node.id?.trim() || nodeIds.has(node.id)) { diagnostics.push(`missing or duplicate topology identity: ${binding.id}.${kind}`); continue; }
        nodeIds.add(node.id);
        recordProcessRef(node.sourceRef);
        facts.acceptanceTopology.push(`${binding.id}:${kind}:${node.id}`);
        for (const producer of ('producerRefs' in node ? node.producerRefs : []) as string[]) facts.acceptanceTopology.push(`${binding.id}:${node.id}->producer:${producer}`);
        for (const consumer of ('consumerRefs' in node ? node.consumerRefs : []) as string[]) facts.acceptanceTopology.push(`${binding.id}:${node.id}->consumer:${consumer}`);
      }
    }
    for (const ref of topology.commandRefs ?? []) recordProcessRef(ref);
  }
  for (const key of SCOPE_BUDGET_DIMENSIONS) facts[key] = unique(facts[key]);
  return { facts, paths, diagnostics };
}

function acceptanceSemantics(subject: ScopeBudgetSubject): Map<string, string> {
  const entries = new Map<string, string>();
  for (const item of subject.checklist.items.filter(item => item.status !== 'withdrawn')) {
    const { id, title, context, userSees, excludes } = item;
    entries.set(`requirement:${id}`, canonicalDigest({ title, context, userSees, excludes }));
    for (const intent of collectVerificationIntents(item)) entries.set(`intent:${id}:${intent.ref}`, canonicalDigest(intent.intent));
  }
  for (const binding of subject.proofStory.acceptanceBindings) entries.set(`binding:${binding.id}`, canonicalDigest(binding));
  return entries;
}

export function evaluateStoryScopeBudget(subject: ScopeBudgetSubject, config: ProofOrStopConfig, base?: ScopeBudgetSubject): StoryScopeBudgetReport {
  const facts = emptyFacts();
  const report: StoryScopeBudgetReport = { schemaVersion: 'story-scope-budget-report.v1', storyId: subject.storyId,
    mode: 'disabled', status: 'disabled', blocking: false, facts,
    counts: Object.fromEntries(SCOPE_BUDGET_DIMENSIONS.map(key => [key, 0])) as Record<ScopeBudgetDimension, number>,
    exceeded: [], diagnostics: [], paths: [], bindingDigest: '' };
  if (config.storyScopeBudget === undefined) return report;
  try {
    const policy = policyFor(config.storyScopeBudget);
    report.mode = policy.mode;
    const current = subjectFacts(subject, policy, config);
    Object.assign(report, current);
    if (base) {
      const previous = subjectFacts(base, policy, config);
      report.diagnostics.push(...previous.diagnostics.map(message => `base: ${message}`));
      for (const key of SCOPE_BUDGET_DIMENSIONS.filter(key => key !== 'devScopeDelta')) {
        report.facts.devScopeDelta.push(...report.facts[key].filter(id => !previous.facts[key].includes(id)).map(id => `${key}:${id}`));
      }
      const priorSemantics = acceptanceSemantics(base);
      for (const [id, digest] of acceptanceSemantics(subject)) {
        if (priorSemantics.get(id) !== digest) report.facts.devScopeDelta.push(`acceptance:${id}:${digest}`);
      }
    }
    for (const key of SCOPE_BUDGET_DIMENSIONS) {
      report.counts[key] = report.facts[key].length;
      if (report.counts[key] > policy.limits[key]) report.exceeded.push(key);
    }
    report.bindingDigest = canonicalDigest({ policy, amendmentBaseDigest: base ? canonicalDigest(base) : null, paths: report.paths, facts: report.facts,
      requirements: subject.checklist.items.map(({ id, title, context, userSees, excludes, files, verificationIntent }) =>
        ({ id, title, context, userSees, excludes, files, verificationIntent })),
      topology: subject.proofStory.acceptanceBindings, validation: config.validate ?? config.validation ?? null });
    report.status = report.diagnostics.length ? 'unknown' : report.exceeded.length ? 'decision_required' : 'within_budget';
    report.blocking = policy.mode === 'enforce' && report.status !== 'within_budget';
  } catch (error) {
    report.status = 'unknown'; report.blocking = true;
    report.diagnostics.push(error instanceof Error ? error.message : String(error));
  }
  return report;
}

export function readStoryScopeBudget(store: StoryStore, root: string, storyId: string, next?: ScopeBudgetSubject, base?: ScopeBudgetSubject): StoryScopeBudgetReport {
  return readScopeBudgetWithLineage(store, root, storyId, next, base, new Set());
}

function readScopeBudgetWithLineage(store: StoryStore, root: string, storyId: string, next: ScopeBudgetSubject | undefined, base: ScopeBudgetSubject | undefined, lineage: Set<string>): StoryScopeBudgetReport {
  if (lineage.has(storyId)) throw new Error(`cyclic scope decomposition: ${storyId}`);
  lineage = new Set([...lineage, storyId]);
  // loadConfig preserves a legacy syntax-error fallback. A malformed policy file
  // cannot turn an enforced budget into that fallback's absent configuration.
  const configPath = pickProjectConfigPath(root);
  if (configPath) JSON.parse(readFileSync(configPath.path, 'utf8'));
  const config = loadConfig(root);
  // Preserve legacy projects without silently treating malformed opted-in policy as absent.
  const subject = next ?? (config.storyScopeBudget === undefined ? { storyId } : {
    storyId, scope: store.readScopeContract(storyId), checklist: store.readChecklist(storyId), proofStory: store.readProofStoryContract(storyId),
  }) as ScopeBudgetSubject;
  const report = evaluateStoryScopeBudget(subject, config, base);
  if (report.mode !== 'disabled') for (const path of report.paths) {
    try {
      const canonical = canonicalFilesystemPath(root, path);
      if (canonical !== resolve(realpathSync(root), path)) report.diagnostics.push(`noncanonical scope alias: ${path}`);
      if (existsSync(canonical) && statSync(canonical).isDirectory()) report.diagnostics.push(`unresolved scope directory: ${path}`);
    } catch { report.diagnostics.push(`unresolved filesystem scope: ${path}`); }
  }
  if (report.diagnostics.length) {
    report.status = 'unknown';
    report.blocking = report.blocking || report.mode === 'enforce';
  }
  if (report.mode !== 'disabled') {
    report.decomposition = readScopeDecomposition(store, subject, report.paths,
      childId => readScopeBudgetWithLineage(store, root, childId, undefined, undefined, lineage));
    if (report.decomposition) {
      report.bindingDigest = canonicalDigest({ budget: report.bindingDigest, decomposition: report.decomposition.bindingDigest });
      if (report.decomposition.status !== 'ready') {
        report.diagnostics.push(...report.decomposition.diagnostics);
        report.status = 'unknown'; report.blocking = report.blocking || report.mode === 'enforce';
      }
    }
  }
  if (report.status === 'decision_required') {
    try {
      if (currentScopeBudgetApproval(store, root, storyId, report.bindingDigest)) {
        report.status = 'approved_large_story'; report.blocking = false;
      }
    } catch (error) {
      report.status = 'unknown'; report.blocking = true;
      report.diagnostics.push(error instanceof Error ? error.message : String(error));
    }
  }
  return report;
}
export function storyScopeBudgetBlocker(store: StoryStore, root: string, storyId: string, next?: ScopeBudgetSubject, base?: ScopeBudgetSubject): string | null {
  try {
    const report = readStoryScopeBudget(store, root, storyId, next, base);
    return report.blocking ? `Scope budget ${report.status}: ${[...report.exceeded, ...report.diagnostics].join(', ')}. ` +
      'Narrow the scope or record a current decomposition or explicit large-Story decision before DEV.' : null;
  } catch (error) { return `Scope budget unknown: ${error instanceof Error ? error.message : String(error)}`; }
}
