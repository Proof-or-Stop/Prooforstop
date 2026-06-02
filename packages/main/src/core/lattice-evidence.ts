import { readFileSync } from 'node:fs';
import { buildCapabilityProbe } from './capabilities.js';
import { buildCanonicalStory } from './canonical-story.js';
import {
  checkEvidenceFreshnessForGit,
  currentGitHead,
  currentMaterialHash,
  type EvidenceFreshness,
} from './evidence-freshness.js';
import type { StoryStore } from './store.js';

export type LatticeEvidenceFreshnessStatus = 'fresh' | 'stale';

export interface LatticeEvidenceFreshness extends EvidenceFreshness {
  status: LatticeEvidenceFreshnessStatus;
}

export interface LatticeEvidenceRef {
  id: string;
  source: string;
  itemId?: string;
  intentRef?: string;
  kind?: string;
  command?: string;
  file?: string;
  transcriptRefs: string[];
  testRefs: string[];
  headHash?: string;
  materialHash?: string;
  freshness: LatticeEvidenceFreshness;
}

export interface LatticeEvidenceAuthorityBoundary {
  canManufactureAuthority: false;
  authorityChanged: false;
  productionDone: false;
  receiptRefs: [];
}

export interface LatticeEvidenceRefreshGuidance {
  refreshOnlyProvidesGuidance: true;
  authorityChanged: false;
  recommendedCommands: string[];
  guidance: string;
}

export interface LatticeEvidenceFreshnessSummary {
  status: LatticeEvidenceFreshnessStatus;
  staleRefs: string[];
  guidance: string;
}

export interface EvidenceManifest {
  schemaVersion: 'koala.evidence_manifest.v1';
  storyId: string;
  sourceHost: string;
  generatedAt: string;
  headHash?: string;
  materialHash?: string;
  transcriptRefs: string[];
  testRefs: string[];
  evidenceRefs: LatticeEvidenceRef[];
  freshness: LatticeEvidenceFreshnessSummary;
  refreshGuidance: LatticeEvidenceRefreshGuidance;
  authority: LatticeEvidenceAuthorityBoundary;
}

export interface EvidenceInspection {
  schemaVersion: 'koala.evidence_inspect.v1';
  manifestSchemaVersion: EvidenceManifest['schemaVersion'];
  storyId: string;
  sourceHost: string;
  generatedAt: string;
  inspectedAt: string;
  headHash?: string;
  materialHash?: string;
  transcriptRefs: string[];
  testRefs: string[];
  evidenceRefs: LatticeEvidenceRef[];
  freshness: LatticeEvidenceFreshnessSummary;
  refreshGuidance: LatticeEvidenceRefreshGuidance;
  authority: LatticeEvidenceAuthorityBoundary;
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function evidenceId(record: Record<string, unknown>, index: number): string {
  return stringField(record, 'id') ?? stringField(record, 'intentRef') ?? `evidence:${index}`;
}

function freshnessFor(root: string, record: Record<string, unknown>): LatticeEvidenceFreshness {
  const result = checkEvidenceFreshnessForGit(
    root,
    stringField(record, 'headHash'),
    stringField(record, 'materialHash'),
  );
  return {
    ...result,
    status: result.fresh ? 'fresh' : 'stale',
  };
}

function unique(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value && value.trim())))].sort();
}

function refsForEvidence(record: Record<string, unknown>, id: string): { transcriptRefs: string[]; testRefs: string[] } {
  const kind = stringField(record, 'kind');
  const command = stringField(record, 'command');
  const file = stringField(record, 'file');
  const source = stringField(record, 'source');
  const transcriptRefs: string[] = [];
  const testRefs: string[] = [];

  if (kind === 'manual_transcript') {
    transcriptRefs.push(file ?? source ?? id);
  }
  if (kind === 'browser_test') {
    transcriptRefs.push(file ?? source ?? id);
  }
  if (kind === 'logic_test' || kind === 'integration_test' || kind === 'browser_test' || kind === 'docs_check') {
    testRefs.push(command ? `command:${command}` : file ?? source ?? id);
  }
  if (source === 'test-evidence.json') {
    testRefs.push(source);
  }
  return {
    transcriptRefs: unique(transcriptRefs),
    testRefs: unique(testRefs),
  };
}

function buildEvidenceRefs(root: string, records: Array<Record<string, unknown>>): LatticeEvidenceRef[] {
  return records.map((record, index) => {
    const id = evidenceId(record, index);
    const refs = refsForEvidence(record, id);
    return {
      id,
      source: stringField(record, 'source') ?? 'canonical-story.evidence',
      ...(stringField(record, 'itemId') ? { itemId: stringField(record, 'itemId') } : {}),
      ...(stringField(record, 'intentRef') ? { intentRef: stringField(record, 'intentRef') } : {}),
      ...(stringField(record, 'kind') ? { kind: stringField(record, 'kind') } : {}),
      ...(stringField(record, 'command') ? { command: stringField(record, 'command') } : {}),
      ...(stringField(record, 'file') ? { file: stringField(record, 'file') } : {}),
      transcriptRefs: refs.transcriptRefs,
      testRefs: refs.testRefs,
      ...(stringField(record, 'headHash') ? { headHash: stringField(record, 'headHash') } : {}),
      ...(stringField(record, 'materialHash') ? { materialHash: stringField(record, 'materialHash') } : {}),
      freshness: freshnessFor(root, record),
    };
  });
}

function summarizeFreshness(refs: LatticeEvidenceRef[]): LatticeEvidenceFreshnessSummary {
  const staleRefs = refs.filter(ref => ref.freshness.status === 'stale').map(ref => ref.id).sort();
  return {
    status: staleRefs.length > 0 ? 'stale' : 'fresh',
    staleRefs,
    guidance: staleRefs.length > 0
      ? 'One or more evidence refs are stale against the current material state. Rerun the referenced verification commands before recording new evidence.'
      : 'All evidence refs are fresh against the current material state, or use legacy hashes that do not support freshness checks.',
  };
}

function refreshGuidance(storyId: string, refs: LatticeEvidenceRef[]): LatticeEvidenceRefreshGuidance {
  const staleRefs = refs.filter(ref => ref.freshness.status === 'stale');
  const recommendedCommands = unique(staleRefs.map(ref => ref.command));
  return {
    refreshOnlyProvidesGuidance: true,
    authorityChanged: false,
    recommendedCommands,
    guidance: staleRefs.length > 0
      ? `Rerun stale evidence for ${storyId}${recommendedCommands.length > 0 ? `: ${recommendedCommands.join(' && ')}` : ''}. Then record fresh verification evidence through the normal Koala evidence commands. This manifest/inspection does not refresh hashes, submit evidence, verify receipts, or grant production authority.`
      : `No evidence refresh is suggested for ${storyId}. This manifest/inspection remains advisory and does not grant production authority.`,
  };
}

function authorityBoundary(): LatticeEvidenceAuthorityBoundary {
  return {
    canManufactureAuthority: false,
    authorityChanged: false,
    productionDone: false,
    receiptRefs: [],
  };
}

export function buildEvidenceManifest(
  store: StoryStore,
  root: string,
  args: { storyId: string; sourceHost: string },
): EvidenceManifest {
  const sourceHost = buildCapabilityProbe(args.sourceHost).host;
  const canonical = buildCanonicalStory(store, root, args.storyId).story;
  const refs = buildEvidenceRefs(root, canonical.evidence);
  return {
    schemaVersion: 'koala.evidence_manifest.v1',
    storyId: args.storyId,
    sourceHost,
    generatedAt: new Date().toISOString(),
    ...(currentGitHead(root) ? { headHash: currentGitHead(root) } : {}),
    ...(currentMaterialHash(root) ? { materialHash: currentMaterialHash(root) } : {}),
    transcriptRefs: unique(refs.flatMap(ref => ref.transcriptRefs)),
    testRefs: unique(refs.flatMap(ref => ref.testRefs)),
    evidenceRefs: refs,
    freshness: summarizeFreshness(refs),
    refreshGuidance: refreshGuidance(args.storyId, refs),
    authority: authorityBoundary(),
  };
}

export function readEvidenceManifest(file: string): EvidenceManifest {
  const parsed = JSON.parse(readFileSync(file, 'utf8')) as EvidenceManifest;
  if (parsed.schemaVersion !== 'koala.evidence_manifest.v1') {
    throw new Error(`evidence_inspect expected schemaVersion koala.evidence_manifest.v1, got ${String((parsed as { schemaVersion?: unknown }).schemaVersion)}`);
  }
  return {
    ...parsed,
    authority: authorityBoundary(),
  };
}

export function inspectEvidenceManifest(manifest: EvidenceManifest, root: string): EvidenceInspection {
  const refs = manifest.evidenceRefs.map(ref => ({
    ...ref,
    freshness: freshnessFor(root, ref as unknown as Record<string, unknown>),
  }));
  return {
    schemaVersion: 'koala.evidence_inspect.v1',
    manifestSchemaVersion: manifest.schemaVersion,
    storyId: manifest.storyId,
    sourceHost: manifest.sourceHost,
    generatedAt: manifest.generatedAt,
    inspectedAt: new Date().toISOString(),
    ...(currentGitHead(root) ? { headHash: currentGitHead(root) } : {}),
    ...(currentMaterialHash(root) ? { materialHash: currentMaterialHash(root) } : {}),
    transcriptRefs: unique(refs.flatMap(ref => ref.transcriptRefs)),
    testRefs: unique(refs.flatMap(ref => ref.testRefs)),
    evidenceRefs: refs,
    freshness: summarizeFreshness(refs),
    refreshGuidance: refreshGuidance(manifest.storyId, refs),
    authority: authorityBoundary(),
  };
}

export function renderEvidenceManifestText(manifest: EvidenceManifest): string {
  return [
    `Evidence manifest (${manifest.schemaVersion})`,
    `storyId: ${manifest.storyId}`,
    `sourceHost: ${manifest.sourceHost}`,
    `headHash: ${manifest.headHash ?? '(unavailable)'}`,
    `materialHash: ${manifest.materialHash ?? '(unavailable)'}`,
    `freshness: ${manifest.freshness.status}`,
    `staleRefs: ${manifest.freshness.staleRefs.length}`,
    `transcriptRefs: ${manifest.transcriptRefs.length}`,
    `testRefs: ${manifest.testRefs.length}`,
    `authorityChanged: ${manifest.authority.authorityChanged}`,
    `productionDone: ${manifest.authority.productionDone}`,
  ].join('\n');
}

export function renderEvidenceInspectionText(inspection: EvidenceInspection): string {
  return [
    `Evidence inspect (${inspection.schemaVersion})`,
    `storyId: ${inspection.storyId}`,
    `sourceHost: ${inspection.sourceHost}`,
    `headHash: ${inspection.headHash ?? '(unavailable)'}`,
    `materialHash: ${inspection.materialHash ?? '(unavailable)'}`,
    `freshness: ${inspection.freshness.status}`,
    `staleRefs: ${inspection.freshness.staleRefs.length}`,
    `transcriptRefs: ${inspection.transcriptRefs.length}`,
    `testRefs: ${inspection.testRefs.length}`,
    `authorityChanged: ${inspection.authority.authorityChanged}`,
    `productionDone: ${inspection.authority.productionDone}`,
  ].join('\n');
}
