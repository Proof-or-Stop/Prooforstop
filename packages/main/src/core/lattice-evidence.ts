import { readFileSync } from 'node:fs';
import { buildCapabilityProbe } from './capabilities.js';
import { buildCanonicalStory, collectReceiptRefs } from './canonical-story.js';
import {
  checkEvidenceFreshnessForGit,
  currentGitHead,
  currentMaterialHash,
  type EvidenceFreshness,
} from './evidence-freshness.js';
import type { StoryStore } from './store.js';
import type { VerificationEvidence } from './types.js';

export type LatticeEvidenceFreshnessStatus = 'fresh' | 'stale';

export interface LatticeEvidenceFreshness extends EvidenceFreshness {
  status: LatticeEvidenceFreshnessStatus;
}

export interface LatticeEvidenceRedaction {
  applied: boolean;
  secretsRedacted: boolean;
  notes: string[];
}

export interface LatticeEvidenceRef {
  id: string;
  source: string;
  itemId?: string;
  intentRef?: string;
  kind?: string;
  result?: VerificationEvidence['result'];
  verdict?: VerificationEvidence['verdict'];
  note?: string;
  waiverType?: VerificationEvidence['waiverType'];
  command?: string;
  file?: string;
  transcriptRefs: string[];
  testRefs: string[];
  headHash?: string;
  materialHash?: string;
  storyFilesHash?: string;
  receiptRefs: string[];
  redaction: LatticeEvidenceRedaction;
  freshness: LatticeEvidenceFreshness;
}

export interface LatticeEvidenceAuthorityBoundary {
  canManufactureAuthority: false;
  authorityChanged: false;
  productionDone: false;
  receiptRefs: string[];
  receiptRefsVerified: false;
  notes: string[];
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
  schemaVersion: 'lattice.evidence_manifest.v1';
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
  redaction: LatticeEvidenceRedaction;
  authority: LatticeEvidenceAuthorityBoundary;
}

export interface EvidenceInspection {
  schemaVersion: 'lattice.evidence_inspect.v1';
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
  redaction: LatticeEvidenceRedaction;
  authority: LatticeEvidenceAuthorityBoundary;
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function booleanField(record: Record<string, unknown>, key: string): boolean | undefined {
  const value = record[key];
  return typeof value === 'boolean' ? value : undefined;
}

function resultField(record: Record<string, unknown>): VerificationEvidence['result'] | undefined {
  const value = record.result;
  return value === 'pass' || value === 'fail' ? value : undefined;
}

function verdictField(record: Record<string, unknown>): VerificationEvidence['verdict'] | undefined {
  const value = record.verdict;
  return value === 'success' || value === 'blocked_classified' || value === 'audit_only' || value === 'waived'
    ? value
    : undefined;
}

function waiverTypeField(record: Record<string, unknown>): VerificationEvidence['waiverType'] | undefined {
  const value = record.waiverType;
  return value === 'permanent' || value === 'deferred_gate_evidence' ? value : undefined;
}

function stringArrayValue(value: unknown): string[] {
  if (typeof value === 'string' && value.trim()) return [value];
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
}

function evidenceId(record: Record<string, unknown>, index: number): string {
  return stringField(record, 'id') ?? stringField(record, 'intentRef') ?? `evidence:${index}`;
}

function freshnessFor(root: string, record: Record<string, unknown>): LatticeEvidenceFreshness {
  const result = checkEvidenceFreshnessForGit(
    root,
    stringField(record, 'headHash'),
    stringField(record, 'materialHash'),
    root,
    stringField(record, 'storyFilesHash'),
  );
  return {
    ...result,
    status: result.fresh ? 'fresh' : 'stale',
  };
}

function unique(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value && value.trim())))].sort();
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter(value => value.trim()))].sort();
}

function redactionForRecord(record: Record<string, unknown>): LatticeEvidenceRedaction {
  const nested = record.redaction && typeof record.redaction === 'object'
    ? record.redaction as Record<string, unknown>
    : {};
  return {
    applied: booleanField(nested, 'applied') ?? booleanField(record, 'redactionApplied') ?? false,
    secretsRedacted: booleanField(nested, 'secretsRedacted') ?? booleanField(record, 'secretsRedacted') ?? false,
    notes: uniqueStrings([
      ...stringArrayValue(nested.notes),
      ...stringArrayValue(record.redactionNotes),
      ...stringArrayValue(record.redactionNote),
    ]),
  };
}

function summarizeRedaction(
  refs: Array<{ redaction: LatticeEvidenceRedaction }>,
  extra?: LatticeEvidenceRedaction,
): LatticeEvidenceRedaction {
  const statuses = extra ? [...refs.map(ref => ref.redaction), extra] : refs.map(ref => ref.redaction);
  const notes = uniqueStrings(statuses.flatMap(status => status.notes));
  return {
    applied: statuses.some(status => status.applied),
    secretsRedacted: statuses.some(status => status.secretsRedacted),
    notes: notes.length > 0 ? notes : ['No redaction metadata was present on source evidence.'],
  };
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
      ...(resultField(record) ? { result: resultField(record) } : {}),
      ...(verdictField(record) ? { verdict: verdictField(record) } : {}),
      ...(stringField(record, 'note') ? { note: stringField(record, 'note') } : {}),
      ...(waiverTypeField(record) ? { waiverType: waiverTypeField(record) } : {}),
      ...(stringField(record, 'command') ? { command: stringField(record, 'command') } : {}),
      ...(stringField(record, 'file') ? { file: stringField(record, 'file') } : {}),
      transcriptRefs: refs.transcriptRefs,
      testRefs: refs.testRefs,
      ...(stringField(record, 'headHash') ? { headHash: stringField(record, 'headHash') } : {}),
      ...(stringField(record, 'materialHash') ? { materialHash: stringField(record, 'materialHash') } : {}),
      ...(stringField(record, 'storyFilesHash') ? { storyFilesHash: stringField(record, 'storyFilesHash') } : {}),
      receiptRefs: collectReceiptRefs(record),
      redaction: redactionForRecord(record),
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
      ? `Rerun stale evidence for ${storyId}${recommendedCommands.length > 0 ? `: ${recommendedCommands.join(' && ')}` : ''}. Then record fresh verification evidence through the normal Proofbound evidence commands. This manifest/inspection does not refresh hashes, submit evidence, verify receipts, or grant release readiness.`
      : `No evidence refresh is suggested for ${storyId}. This manifest/inspection remains advisory and does not grant release readiness.`,
  };
}

function authorityBoundary(receiptRefs: string[]): LatticeEvidenceAuthorityBoundary {
  return {
    canManufactureAuthority: false,
    authorityChanged: false,
    productionDone: false,
    receiptRefs: uniqueStrings(receiptRefs),
    receiptRefsVerified: false,
    notes: [
      'Receipt refs are unverified local or diagnostic refs only; they do not change authority tier or productionDone.',
    ],
  };
}

function normalizeEvidenceRef(ref: LatticeEvidenceRef): LatticeEvidenceRef {
  const record = ref as unknown as Record<string, unknown>;
  return {
    ...ref,
    transcriptRefs: stringArrayValue(record.transcriptRefs),
    testRefs: stringArrayValue(record.testRefs),
    receiptRefs: uniqueStrings([
      ...stringArrayValue(record.receiptRefs),
      ...collectReceiptRefs(record),
    ]),
    redaction: redactionForRecord(record),
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
  const receiptRefs = uniqueStrings([
    ...canonical.authority.receiptRefs,
    ...refs.flatMap(ref => ref.receiptRefs),
  ]);
  return {
    schemaVersion: 'lattice.evidence_manifest.v1',
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
    redaction: summarizeRedaction(refs),
    authority: authorityBoundary(receiptRefs),
  };
}

export function readEvidenceManifest(file: string): EvidenceManifest {
  const parsed = JSON.parse(readFileSync(file, 'utf8')) as EvidenceManifest;
  if (parsed.schemaVersion !== 'lattice.evidence_manifest.v1') {
    throw new Error(`evidence_inspect expected schemaVersion lattice.evidence_manifest.v1, got ${String((parsed as { schemaVersion?: unknown }).schemaVersion)}`);
  }
  const refs = (parsed.evidenceRefs ?? []).map(ref => normalizeEvidenceRef(ref));
  const redaction = redactionForRecord(parsed as unknown as Record<string, unknown>);
  const receiptRefs = uniqueStrings([
    ...stringArrayValue((parsed.authority as unknown as Record<string, unknown> | undefined)?.receiptRefs),
    ...refs.flatMap(ref => ref.receiptRefs),
  ]);
  return {
    ...parsed,
    evidenceRefs: refs,
    redaction: summarizeRedaction(refs, redaction),
    authority: authorityBoundary(receiptRefs),
  };
}

export function inspectEvidenceManifest(manifest: EvidenceManifest, root: string): EvidenceInspection {
  const refs = manifest.evidenceRefs.map(ref => {
    const normalized = normalizeEvidenceRef(ref);
    return {
      ...normalized,
      freshness: freshnessFor(root, normalized as unknown as Record<string, unknown>),
    };
  });
  const receiptRefs = uniqueStrings([
    ...manifest.authority.receiptRefs,
    ...refs.flatMap(ref => ref.receiptRefs),
  ]);
  return {
    schemaVersion: 'lattice.evidence_inspect.v1',
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
    redaction: summarizeRedaction(refs, manifest.redaction),
    authority: authorityBoundary(receiptRefs),
  };
}

export function inspectEvidenceStory(
  store: StoryStore,
  root: string,
  args: { storyId: string; sourceHost: string },
): EvidenceInspection {
  return inspectEvidenceManifest(buildEvidenceManifest(store, root, args), root);
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
    `receiptRefs: ${manifest.authority.receiptRefs.length} unverified`,
    `redactionApplied: ${manifest.redaction.applied}`,
    `secretsRedacted: ${manifest.redaction.secretsRedacted}`,
    'admissibilityStatus: evidence-manifest',
    'assuranceLevel: local',
    'evidenceScope: portable-evidence',
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
    `receiptRefs: ${inspection.authority.receiptRefs.length} unverified`,
    `redactionApplied: ${inspection.redaction.applied}`,
    `secretsRedacted: ${inspection.redaction.secretsRedacted}`,
    'admissibilityStatus: evidence-inspection',
    'assuranceLevel: local',
    'evidenceScope: portable-evidence',
  ].join('\n');
}
