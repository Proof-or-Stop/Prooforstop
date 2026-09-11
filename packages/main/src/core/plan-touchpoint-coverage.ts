import type { ChecklistItem } from './types.js';

export function normalizeTouchpointPath(value: string): string {
  const trimmed = value
    .trim()
    .replace(/^[-*]\s+/, '')
    .replace(/^`|`$/g, '')
    .trim();
  const firstSegment = trimmed.split(/\s+\(/)[0].split(/\s+-\s+/)[0].trim();
  const token = firstSegment.split(/\s+/)[0] || firstSegment;
  return token.replace(/[),:;]+$/g, '').replace(/^`|`$/g, '').trim();
}

export function assessPlanTouchpointCoverage(touchpoints: readonly string[], items: readonly Pick<ChecklistItem, 'files'>[]) {
  const issues: Array<{ type: 'touchpoint_mapping_missing' | 'touchpoint_uncovered'; severity: 'advisory' | 'blocker'; message: string }> = [];
  if (touchpoints.length > 0) {
    const itemsWithFiles = items.filter(i => !!i.files);
    if (itemsWithFiles.length === 0) {
      issues.push({
        type: 'touchpoint_mapping_missing',
        severity: 'advisory',
        message: 'None of the checklist items have the files field filled in (legacy story compatibility mode); cannot perform coverage validation on understanding.touchpoints. Please list the changed files in files.modify/create/test for at least one item to enable strict touchpoint-to-files validation',
      });
    } else {
      // Strict validation mode: collect all file paths declared by items
      const covered = new Set<string>();
      for (const item of itemsWithFiles) {
        const f = item.files!;
        for (const p of f.modify || []) covered.add(normalizeTouchpointPath(p));
        for (const p of f.create || []) covered.add(normalizeTouchpointPath(p));
        for (const p of f.test || []) covered.add(normalizeTouchpointPath(p));
      }
      for (const tp of touchpoints) {
        const normalizedTp = normalizeTouchpointPath(tp);
        if (!covered.has(normalizedTp)) {
          issues.push({
            type: 'touchpoint_uncovered',
            severity: 'blocker',
            message: `touchpoint_uncovered: ${tp} is not covered by the files field of any checklist item (please add this path to the corresponding item's files.modify/create/test or explicitly exclude it via excludes)`,
          });
        }
      }
    }
  }

  return issues;
}


// IO boundary: these facts must be rederived in the workspace that spends them.
import { readFileSync, lstatSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { digestCanonicalJson } from './digest.js';
import { buildAcceptanceMatrixReport } from './acceptance-topology.js';
import { projectProcessFactRegistry } from './process-fact-registry.js';
import { signValidationArtifact, verifyValidationArtifact } from './validation-artifact-signing.js';
import type { StoryStore } from './store.js';

export interface PlanOwnerDisposition { path: string; disposition: 'modify' | 'test' | 'unchanged'; reason: string }
export interface PlanOwnerCoverage {
  domain: 'plan-owner-coverage.v1'; storyId: string; actor: string;
  binding: string; dispositions: PlanOwnerDisposition[]; signature: string;
}
export const PLAN_OWNER_REGISTRY_INPUTS = ['packages/main/src/core/process-fact-registry.ts','packages/main/src/core/command-policy.ts','packages/main/src/core/process-fact-levels.ts','packages/main/src/core/flow-fact-policy.ts'] as const;
const SCOPE_ROLE = 'proof-or-stop-review-scope-plan';

export function currentPlanOwnerBinding(store: StoryStore, root: string, storyId: string) {
  const contract = store.readProofStoryContract(storyId);
  const previous = store.readScopeCheck(storyId)?.ownerCoverage;
  if (!contract) {
    if (previous) throw new Error('previous owner topology removed');
    return null;
  }
  if (!Array.isArray(contract.acceptanceBindings)) throw new Error('malformed acceptance bindings');
  if (contract.acceptanceBindings.some(binding => binding?.verificationTopology !== undefined)) {
    const syntaxCodes = new Set(['AT_UNKNOWN_REF','AT_PLANNED_PATH_DECLARATION_MISSING','AT_PLANNED_PATH_DECLARATION_DRIFT','AT_UNSUPPORTED_VERSION','AT_DUPLICATE_ID','AT_ORPHAN_CONSUMER','AT_ORPHAN_PRODUCER']);
    const report = buildAcceptanceMatrixReport({storyId,contract,checklist:store.readChecklist(storyId),ledger:store.readMilestoneLedger(storyId)});
    const invalid = report.diagnostics.find(row => syntaxCodes.has(row.code));
    if (invalid) throw new Error(`invalid owner topology: ${invalid.code} ${invalid.message}`);
  }
  const selected = new Set<string>();
  const topologies: unknown[] = [];
  for (const binding of contract.acceptanceBindings) {
    if (!binding || typeof binding !== 'object') throw new Error('malformed acceptance binding');
    const topology = binding.verificationTopology;
    if (topology === undefined) continue;
    if (!topology || topology.schemaVersion !== 'proofstory.acceptance_topology.v1') throw new Error('malformed owner topology');
    topologies.push({id: binding.id, topology});
    for (const group of ['producerRefs', 'consumerRefs','positiveAssertionRefs','mutationCaseRefs','transcriptAssertionRefs','commandRefs'] as const) {
      if (topology[group] === undefined && !['producerRefs','consumerRefs'].includes(group)) continue;
      if (!Array.isArray(topology[group])) throw new Error('malformed topology refs');
      for (const node of topology[group]) {
        const ref = (group === 'commandRefs' ? node : (node as {sourceRef?: unknown})?.sourceRef) as {refKind?: unknown; canonicalSourceRef?: unknown} | undefined;
        if (!ref || typeof ref !== 'object' || typeof ref.refKind !== 'string' || !['existing', 'planned'].includes(ref.refKind)) throw new Error('malformed topology source ref');
        if (ref.refKind !== 'existing') continue;
        if (typeof ref.canonicalSourceRef !== 'string') throw new Error('malformed canonical source ref');
        if (ref.canonicalSourceRef.startsWith('process-fact:')) selected.add(ref.canonicalSourceRef.slice('process-fact:'.length));
      }
    }
  }
  if (!selected.size) {
    if (previous) throw new Error('previous selected owner facts removed');
    return null;
  }
  const registry = projectProcessFactRegistry();
  const rows = [...selected].sort().map(id => {
    const row = registry.find(entry => entry.factId === id);
    if (!row) throw new Error(`unknown selected process fact ${id}`);
    return row;
  });
  const paths = [...new Set(rows.flatMap(row => row.paths))].sort();
  const sources = [...new Set([...paths,...PLAN_OWNER_REGISTRY_INPUTS])].sort().map(path => {
    const file = resolve(root, path);
    if (!file.startsWith(resolve(root) + '/') || realpathSync(file) !== file || !lstatSync(file).isFile()) throw new Error(`invalid owner source ${path}`);
    const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
    let main: string | null = null;
    const git = (args: string[]) => execFileSync('git', args, {cwd:root,stdio:['ignore','pipe','pipe']});
    if (git(['for-each-ref','--format=%(refname)','refs/heads/main']).toString().trim()) {
      const entry = git(['ls-tree','--format=%(objectname)','refs/heads/main','--',path]).toString().trim();
      if (entry) main = digest(git(['cat-file','blob',entry]));
    }
    return {path, current: digest(readFileSync(file)), main};
  });
  const checklist = store.readChecklist(storyId).items.map(item => ({id:item.id,title:item.title,context:item.context,userSees:item.userSees,excludes:item.excludes,verificationIntent:item.verificationIntent,files:item.files ?? null}));
  const touchpoints = store.readUnderstanding(storyId)?.touchpoints ?? [];
  return {paths, checklist, binding:digestCanonicalJson({storyId,reviewRound:store.readStory(storyId).currentReviewRound ?? '',contract,topologies,rows,sources,checklist,touchpoints})};
}

function validateOwnerDispositions(current: NonNullable<ReturnType<typeof currentPlanOwnerBinding>>, input: unknown): PlanOwnerDisposition[] {
  if (!Array.isArray(input) || input.length !== current.paths.length) throw new Error('every selected owner requires one disposition');
  const seen = new Set<string>();
  for (const row of input) {
    if (!row || typeof row !== 'object' || Object.keys(row).sort().join(',') !== 'disposition,path,reason'
      || !current.paths.includes(row.path) || seen.has(row.path)
      || !['modify','test','unchanged'].includes(row.disposition)
      || typeof row.reason !== 'string' || row.reason.trim().length < 40) throw new Error('invalid or missing substantive owner disposition');
    seen.add(row.path);
    if (row.disposition !== 'unchanged' && !current.checklist.some(item => item.files?.[row.disposition as 'modify'|'test']?.includes(row.path))) throw new Error(`owner ${row.path} is absent from declared ${row.disposition} files`);
  }
  return [...input].sort((a,b)=>a.path.localeCompare(b.path));
}

export function signPlanOwnerCoverage(store: StoryStore, root: string, storyId: string, input: unknown, actor: string | undefined): PlanOwnerCoverage | undefined {
  const current = currentPlanOwnerBinding(store, root, storyId);
  if (!current) {
    if (input !== undefined) throw new Error('owner dispositions require selected canonical process facts');
    return undefined;
  }
  if (actor !== SCOPE_ROLE) throw new Error('selected owner coverage requires the registered scope reviewer');
  const dispositions = validateOwnerDispositions(current,input);
  const payload = {domain:'plan-owner-coverage.v1' as const,storyId,actor,binding:current.binding,dispositions};
  return {...payload,signature:signValidationArtifact(payload,root)};
}

export function planOwnerCoverageFailure(store: StoryStore, root: string, storyId: string): string | null {
  try {
    const current = currentPlanOwnerBinding(store,root,storyId);
    if (!current) return null;
    const record = store.readScopeCheck(storyId)?.ownerCoverage;
    if (!record) throw new Error('missing authenticated owner coverage');
    if (Object.keys(record).sort().join(',') !== 'actor,binding,dispositions,domain,signature,storyId' || !/^ed25519:validation-artifact-v1:[A-Za-z0-9+/]{86}==$/.test(record.signature)) throw new Error('malformed owner signature envelope');
    const {signature,...payload} = record;
    if (record.domain !== 'plan-owner-coverage.v1' || record.storyId !== storyId || record.actor !== SCOPE_ROLE
      || record.binding !== current.binding || !verifyValidationArtifact(payload,signature,root)) throw new Error('stale or unauthenticated owner coverage');
    validateOwnerDispositions(current,record.dispositions);
    return null;
  } catch (error) { return `plan_owner_coverage_invalid: ${error instanceof Error ? error.message : String(error)}`; }
}
