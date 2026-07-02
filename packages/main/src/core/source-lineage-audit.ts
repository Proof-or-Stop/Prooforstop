import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import {
  resolveGlobalMemoryReadPaths,
  resolveProjectMemoryReadPaths,
  validateEntry,
} from './dev-memory.js';
import { digestCanonicalJson } from './digest.js';
import type {
  FindingSignalsCache,
  Playbook,
  PlaybookProposal,
  SourceLineageArtifactKind,
  SourceLineageAuditRecord,
  SourceLineageAuditReport,
  SourceLineageCanonicalKeyVersion,
  SourceLineageDiagnostic,
} from './experience-layer-types.js';
import {
  buildPlaybookSourceReference,
  readPlaybookOutcomeEventsWithDiagnostics,
  readPlaybookPromotionDecisionRows,
  resolveFindingSignalsPath,
  resolvePlaybookOutcomesPath,
  resolvePlaybookPromotionDecisionsPath,
  resolvePlaybooksPath,
  resolveProposalsDir,
  validatePlaybook,
} from './learning-store.js';

export const SOURCE_LINEAGE_AUDIT_SCHEMA_VERSION = 'proofbound.source-lineage-audit.v1' as const;
export const SOURCE_LINEAGE_CANONICAL_KEY_VERSION: SourceLineageCanonicalKeyVersion = 'proofbound.learning-source-key.v1';

const CANONICALIZATION_POLICY = {
  version: SOURCE_LINEAGE_CANONICAL_KEY_VERSION,
  domain: 'learning',
  trimWhitespace: true,
  sourcePriority: [
    'finding-backed tuple: sourceStoryId + sourceFindingId + optional sourceSignature',
    'raw source key when a learning store already persisted one',
    'story-backed tuple: sourceStoryId + artifactKind + artifactId',
  ],
  hash: 'sha256 canonical JSON, PBLS-16 prefix for emitted source keys',
} as const;

export const SOURCE_LINEAGE_CANONICALIZATION_POLICY_HASH = digestCanonicalJson(CANONICALIZATION_POLICY);

interface SourceLineageStorePort {
  listStoryIds(): string[];
  readFindings(storyId: string): { findings?: unknown[] };
  storyFilePath?(storyId: string, file: string): string;
}

export interface BuildSourceLineageAuditOptions {
  projectRoot: string;
  store: SourceLineageStorePort;
  now?: string;
}

interface LineageInput {
  artifactKind: SourceLineageArtifactKind;
  artifactId: string;
  sourceStoryId?: string;
  sourceFindingId?: string;
  sourceSignature?: string;
  rawSourceKey?: string;
  support?: number;
  anchorRefs?: string[];
}

const FINDING_REF_RE = /\b(B-[A-Za-z0-9][A-Za-z0-9._-]*:F-[0-9]+)\b/;
const STORY_REF_RE = /\b(B-[A-Za-z0-9][A-Za-z0-9._-]*)\b/;

function trim(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const out = value.trim();
  return out || undefined;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string').map((item) => item.trim()).filter(Boolean);
}

function presentAnchorRefs(projectRoot: string, refs: string[]): string[] {
  return refs.filter((ref) => existsSync(join(projectRoot, ref)));
}

function storyIdFromFindingId(findingId: string | undefined): string | undefined {
  if (!findingId) return undefined;
  const idx = findingId.indexOf(':');
  return idx > 0 ? findingId.slice(0, idx) : undefined;
}

function normalizeFindingId(storyId: string | undefined, findingId: string | undefined): string | undefined {
  if (!findingId) return undefined;
  if (findingId.includes(':')) return findingId;
  return storyId ? `${storyId}:${findingId}` : findingId;
}

function sourceKeyFromLineage(input: {
  sourceStoryId?: string;
  sourceFindingId?: string;
  sourceSignature?: string;
}): string | undefined {
  if (!input.sourceStoryId || !input.sourceFindingId) return undefined;
  return buildPlaybookSourceReference({
    sourceStoryId: input.sourceStoryId,
    sourceFindingId: input.sourceFindingId,
    ...(input.sourceSignature ? { sourceSignature: input.sourceSignature } : {}),
  }).sourceKey;
}

function canonicalSourceKey(input: LineageInput): string | null {
  const sourceStoryId = trim(input.sourceStoryId);
  const sourceFindingId = normalizeFindingId(sourceStoryId, trim(input.sourceFindingId));
  const sourceSignature = trim(input.sourceSignature);
  const rawSourceKey = trim(input.rawSourceKey);

  if (sourceStoryId && sourceFindingId) {
    return `PBLS-${digestCanonicalJson({
      kind: 'finding-backed',
      sourceFindingId,
      sourceSignature: sourceSignature ?? null,
      sourceStoryId,
    }).slice(0, 16)}`;
  }
  if (rawSourceKey) {
    return `PBLS-${digestCanonicalJson({ kind: 'raw-source-key', rawSourceKey }).slice(0, 16)}`;
  }
  if (sourceStoryId) {
    return `PBLS-${digestCanonicalJson({
      artifactId: input.artifactId,
      artifactKind: input.artifactKind,
      kind: 'story-backed',
      sourceStoryId,
    }).slice(0, 16)}`;
  }
  return null;
}

function makeRecord(input: LineageInput & { sourceRef: string }): SourceLineageAuditRecord {
  const sourceStoryId = trim(input.sourceStoryId) ?? storyIdFromFindingId(trim(input.sourceFindingId));
  const sourceFindingId = normalizeFindingId(sourceStoryId, trim(input.sourceFindingId));
  const sourceSignature = trim(input.sourceSignature);
  const rawSourceKey = trim(input.rawSourceKey) ?? sourceKeyFromLineage({ sourceStoryId, sourceFindingId, sourceSignature });
  const support = typeof input.support === 'number' && Number.isFinite(input.support) ? Math.max(0, Math.floor(input.support)) : undefined;
  const anchorRefs = stringArray(input.anchorRefs);
  const canonical = canonicalSourceKey({
    artifactKind: input.artifactKind,
    artifactId: input.artifactId,
    sourceStoryId,
    sourceFindingId,
    sourceSignature,
    rawSourceKey,
  });
  return {
    artifactKind: input.artifactKind,
    artifactId: input.artifactId,
    sourceRef: input.sourceRef,
    canonicalSourceKey: canonical,
    canonicalSourceKeyVersion: SOURCE_LINEAGE_CANONICAL_KEY_VERSION,
    canonicalizationPolicyHash: SOURCE_LINEAGE_CANONICALIZATION_POLICY_HASH,
    ...(rawSourceKey ? { rawSourceKey } : {}),
    ...(sourceStoryId ? { sourceStoryId } : {}),
    ...(sourceFindingId ? { sourceFindingId } : {}),
    ...(sourceSignature ? { sourceSignature } : {}),
    ...(support !== undefined ? { support } : {}),
    ...(anchorRefs.length > 0 ? { anchorRefs } : {}),
    lineagePresent: canonical !== null,
    authority: 'non_authoritative',
    gateEvidence: false,
  };
}

function diagnostic(
  diagnostics: SourceLineageDiagnostic[],
  code: string,
  message: string,
  extras: Omit<SourceLineageDiagnostic, 'code' | 'message' | 'severity'> & { severity?: 'info' | 'warning' } = {},
): void {
  const { severity = 'warning', ...rest } = extras;
  diagnostics.push({ code, severity, message, ...rest });
}

function parseJsonFile(filePath: string, diagnostics: SourceLineageDiagnostic[], label: string): unknown | undefined {
  if (!existsSync(filePath)) {
    diagnostic(diagnostics, 'store_missing', `${label} store is absent`, { path: filePath, severity: 'info' });
    return undefined;
  }
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch (err) {
    diagnostic(diagnostics, 'store_malformed', `${label} store is malformed JSON: ${(err as Error).message}`, { path: filePath });
    return undefined;
  }
}

function parseJsonlFile<T>(
  filePath: string,
  label: string,
  validate: (raw: unknown) => { ok: true; value: T } | { ok: false; error: string },
  diagnostics: SourceLineageDiagnostic[],
): T[] {
  if (!existsSync(filePath)) {
    diagnostic(diagnostics, 'store_missing', `${label} store is absent`, { path: filePath, severity: 'info' });
    return [];
  }
  const out: T[] = [];
  const lines = readFileSync(filePath, 'utf8').split('\n');
  lines.forEach((line, index) => {
    if (!line.trim()) return;
    try {
      const result = validate(JSON.parse(line));
      if (result.ok) out.push(result.value);
      else {
        diagnostic(diagnostics, 'store_malformed_row', `${label} row ${index + 1} is malformed: ${result.error}`, {
          path: `${filePath}:${index + 1}`,
        });
      }
    } catch (err) {
      diagnostic(diagnostics, 'store_malformed_row', `${label} row ${index + 1} is invalid JSON: ${(err as Error).message}`, {
        path: `${filePath}:${index + 1}`,
      });
    }
  });
  return out;
}

function collectDevMemory(projectRoot: string, store: SourceLineageStorePort, records: SourceLineageAuditRecord[], diagnostics: SourceLineageDiagnostic[]): void {
  const paths = [
    ...resolveProjectMemoryReadPaths(projectRoot),
    ...resolveGlobalMemoryReadPaths(),
  ];
  let storyIds: string[] = [];
  try {
    storyIds = store.listStoryIds();
  } catch (err) {
    diagnostic(diagnostics, 'story_scan_failed', `could not list stories for dev-memory candidates: ${(err as Error).message}`);
  }
  for (const storyId of storyIds) {
    if (store.storyFilePath) paths.push(store.storyFilePath(storyId, 'dev-memory-candidates.jsonl'));
  }

  const seen = new Set<string>();
  for (const path of paths) {
    if (seen.has(path)) continue;
    seen.add(path);
    const entries = parseJsonlFile(path, 'dev-memory', (raw) => {
      const result = validateEntry(raw);
      return result.ok ? { ok: true, value: result.entry } : { ok: false, error: result.error };
    }, diagnostics);
    entries.forEach((entry, index) => {
      const evidenceRefs = stringArray((entry as { evidenceRefs?: unknown }).evidenceRefs);
      const findingRef = evidenceRefs.map((ref) => ref.match(FINDING_REF_RE)?.[1]).find(Boolean);
      const storyRef = trim((entry as { sourceStoryId?: unknown }).sourceStoryId)
        ?? storyIdFromFindingId(findingRef)
        ?? evidenceRefs.map((ref) => ref.match(STORY_REF_RE)?.[1]).find(Boolean);
      records.push(makeRecord({
        artifactKind: 'dev_memory',
        artifactId: entry.id,
        sourceRef: `${path}:${index + 1}`,
        sourceStoryId: storyRef,
        sourceFindingId: findingRef,
      }));
    });
  }
}

function collectFindingSignals(projectRoot: string, records: SourceLineageAuditRecord[], diagnostics: SourceLineageDiagnostic[]): void {
  const path = resolveFindingSignalsPath(projectRoot);
  const parsed = parseJsonFile(path, diagnostics, 'finding-signals');
  if (parsed === undefined) return;
  const cache = parsed as Partial<FindingSignalsCache>;
  if (!Array.isArray(cache.signals)) {
    diagnostic(diagnostics, 'store_malformed', 'finding-signals store must contain signals[]', { path });
    return;
  }
  cache.signals.forEach((signal, index) => {
    const localSignature = trim((signal as { localSignature?: unknown }).localSignature) ?? `signal-${index + 1}`;
    const findingIds = stringArray((signal as { exampleFindingIds?: unknown }).exampleFindingIds);
    const storyIds = stringArray((signal as { exampleStoryIds?: unknown }).exampleStoryIds);
    const sourceSignature = trim((signal as { signatureTag?: unknown }).signatureTag);
    const rawSupport = (signal as { support?: unknown }).support;
    const support = typeof rawSupport === 'number' && Number.isFinite(rawSupport) ? rawSupport : undefined;
    const anchorRefs = presentAnchorRefs(projectRoot, stringArray((signal as { anchorFiles?: unknown }).anchorFiles));
    if (findingIds.length === 0 && storyIds.length === 0) {
      records.push(makeRecord({
        artifactKind: 'finding_signal',
        artifactId: localSignature,
        sourceRef: `${path}#signals[${index}]`,
        support,
        anchorRefs,
      }));
      return;
    }
    const refs = findingIds.length > 0 ? findingIds : storyIds;
    refs.forEach((ref, refIndex) => {
      const storyId = storyIdFromFindingId(ref) ?? storyIds[refIndex] ?? storyIds[0];
      records.push(makeRecord({
        artifactKind: 'finding_signal',
        artifactId: `${localSignature}#${refIndex + 1}`,
        sourceRef: `${path}#signals[${index}]`,
        sourceStoryId: storyId,
        sourceFindingId: ref.includes(':') ? ref : undefined,
        sourceSignature,
        support,
        anchorRefs,
      }));
    });
  });
}

function collectRawFindings(store: SourceLineageStorePort, records: SourceLineageAuditRecord[], diagnostics: SourceLineageDiagnostic[]): void {
  let storyIds: string[] = [];
  try {
    storyIds = store.listStoryIds();
  } catch (err) {
    diagnostic(diagnostics, 'story_scan_failed', `could not list stories for findings: ${(err as Error).message}`);
    return;
  }
  for (const storyId of storyIds) {
    let data: { findings?: unknown[] };
    try {
      data = store.readFindings(storyId);
    } catch (err) {
      diagnostic(diagnostics, 'finding_store_malformed', `could not read findings for ${storyId}: ${(err as Error).message}`, {
        artifactKind: 'finding',
        artifactId: storyId,
      });
      continue;
    }
    if (!Array.isArray(data.findings)) {
      diagnostic(diagnostics, 'finding_store_malformed', `findings for ${storyId} did not contain findings[]`, {
        artifactKind: 'finding',
        artifactId: storyId,
      });
      continue;
    }
    data.findings.forEach((raw, index) => {
      const obj = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw as Record<string, unknown> : {};
      const id = trim(obj.id);
      const sourceFindingId = normalizeFindingId(storyId, id);
      const sourceSignature = trim(obj.signatureTag);
      records.push(makeRecord({
        artifactKind: 'finding',
        artifactId: id ?? `${storyId}:finding-${index + 1}`,
        sourceRef: store.storyFilePath ? `${store.storyFilePath(storyId, 'findings.json')}#findings[${index}]` : `${storyId}:findings[${index}]`,
        sourceStoryId: storyId,
        sourceFindingId,
        sourceSignature,
      }));
    });
  }
}

function collectPlaybooks(projectRoot: string, records: SourceLineageAuditRecord[], diagnostics: SourceLineageDiagnostic[]): Playbook[] {
  const path = resolvePlaybooksPath(projectRoot);
  const parsed = parseJsonFile(path, diagnostics, 'playbooks');
  if (parsed === undefined) return [];
  if (!Array.isArray(parsed)) {
    diagnostic(diagnostics, 'store_malformed', 'playbooks store must be an array', { path, artifactKind: 'playbook' });
    return [];
  }
  const playbooks: Playbook[] = [];
  parsed.forEach((raw, index) => {
    const validation = validatePlaybook(raw);
    if (!validation.ok) {
      diagnostic(diagnostics, 'store_malformed_row', `playbook row ${index} is malformed: ${validation.error}`, {
        path: `${path}#${index}`,
        artifactKind: 'playbook',
      });
      return;
    }
    const playbook = validation.playbook;
    playbooks.push(playbook);
    const source = buildPlaybookSourceReference(playbook.lineage);
    records.push(makeRecord({
      artifactKind: 'playbook',
      artifactId: playbook.id,
      sourceRef: `${path}#${index}`,
      sourceStoryId: source.sourceStoryId,
      sourceFindingId: source.sourceFindingId,
      sourceSignature: source.sourceSignature,
      rawSourceKey: source.sourceKey,
    }));
  });
  return playbooks;
}

function collectProposals(projectRoot: string, records: SourceLineageAuditRecord[], diagnostics: SourceLineageDiagnostic[]): void {
  const dir = resolveProposalsDir(projectRoot);
  if (!existsSync(dir)) {
    diagnostic(diagnostics, 'store_missing', 'proposals store is absent', { path: dir, severity: 'info' });
    return;
  }
  let names: string[] = [];
  try {
    if (!statSync(dir).isDirectory()) {
      diagnostic(diagnostics, 'store_malformed', 'proposals path is not a directory', { path: dir, artifactKind: 'playbook_proposal' });
      return;
    }
    names = readdirSync(dir).filter((name) => name.endsWith('.json')).sort();
  } catch (err) {
    diagnostic(diagnostics, 'store_malformed', `could not read proposals directory: ${(err as Error).message}`, { path: dir });
    return;
  }
  for (const name of names) {
    const path = join(dir, name);
    const parsed = parseJsonFile(path, diagnostics, 'proposal');
    if (parsed === undefined) continue;
    const proposal = parsed as Partial<PlaybookProposal>;
    const id = trim(proposal.id) ?? name.slice(0, -'.json'.length);
    const lineage = proposal.lineage;
    if (!lineage || typeof lineage !== 'object' || Array.isArray(lineage)) {
      records.push(makeRecord({
        artifactKind: 'playbook_proposal',
        artifactId: id,
        sourceRef: path,
      }));
      continue;
    }
    const rawLineage = lineage as unknown as Record<string, unknown>;
    const sourceStoryId = trim(rawLineage.sourceStoryId);
    const sourceFindingId = trim(rawLineage.sourceFindingId);
    const sourceSignature = trim(rawLineage.sourceSignature);
    records.push(makeRecord({
      artifactKind: 'playbook_proposal',
      artifactId: id,
      sourceRef: path,
      sourceStoryId,
      sourceFindingId,
      sourceSignature,
      rawSourceKey: sourceKeyFromLineage({ sourceStoryId, sourceFindingId, sourceSignature }),
    }));
  }
}

function collectOutcomes(projectRoot: string, playbooks: Playbook[], records: SourceLineageAuditRecord[], diagnostics: SourceLineageDiagnostic[]): void {
  const path = resolvePlaybookOutcomesPath(projectRoot);
  const outcomeRows = readPlaybookOutcomeEventsWithDiagnostics(projectRoot);
  if (!existsSync(path)) {
    diagnostic(diagnostics, 'store_missing', 'playbook outcomes store is absent', { path, severity: 'info' });
  } else if (outcomeRows.malformedCount > 0) {
    diagnostic(diagnostics, 'store_malformed_row', `playbook outcomes skipped malformed rows: ${outcomeRows.malformedCount}`, {
      path,
      artifactKind: 'playbook_outcome',
    });
  }
  const playbookById = new Map(playbooks.map((playbook) => [playbook.id, playbook]));
  outcomeRows.events.forEach((event) => {
    const playbook = playbookById.get(event.playbookId);
    const source = playbook ? buildPlaybookSourceReference(playbook.lineage) : undefined;
    records.push(makeRecord({
      artifactKind: 'playbook_outcome',
      artifactId: event.eventId,
      sourceRef: `${path}#${event.eventId}`,
      sourceStoryId: source?.sourceStoryId,
      sourceFindingId: source?.sourceFindingId,
      sourceSignature: source?.sourceSignature,
      rawSourceKey: source?.sourceKey,
    }));
  });
}

function collectDecisions(projectRoot: string, records: SourceLineageAuditRecord[], diagnostics: SourceLineageDiagnostic[]): void {
  const path = resolvePlaybookPromotionDecisionsPath(projectRoot);
  const decisionRows = readPlaybookPromotionDecisionRows(projectRoot);
  if (!existsSync(path)) {
    diagnostic(diagnostics, 'store_missing', 'playbook promotion decisions store is absent', { path, severity: 'info' });
  } else if (decisionRows.malformedCount > 0) {
    diagnostic(diagnostics, 'store_malformed_row', `playbook promotion decisions skipped malformed rows: ${decisionRows.malformedCount}`, {
      path,
      artifactKind: 'playbook_promotion_decision',
    });
  }
  decisionRows.decisions.forEach((decision) => {
    const source = decision.aggregate.source;
    records.push(makeRecord({
      artifactKind: 'playbook_promotion_decision',
      artifactId: decision.decisionId,
      sourceRef: `${path}#${decision.decisionId}`,
      sourceStoryId: source.sourceStoryId,
      sourceFindingId: source.sourceFindingId,
      sourceSignature: source.sourceSignature,
      rawSourceKey: source.sourceKey || decision.before.sourceKey,
    }));
  });
}

function duplicateGroups(records: SourceLineageAuditRecord[]) {
  const byKey = new Map<string, SourceLineageAuditRecord[]>();
  for (const record of records) {
    if (!record.canonicalSourceKey) continue;
    const list = byKey.get(record.canonicalSourceKey) ?? [];
    list.push(record);
    byKey.set(record.canonicalSourceKey, list);
  }
  return [...byKey.entries()]
    .filter(([, group]) => group.length > 1)
    .map(([canonicalSourceKey, group]) => ({
      canonicalSourceKey,
      recordCount: group.length,
      records: group.sort((a, b) => `${a.artifactKind}:${a.artifactId}`.localeCompare(`${b.artifactKind}:${b.artifactId}`)),
    }))
    .sort((a, b) => a.canonicalSourceKey.localeCompare(b.canonicalSourceKey));
}

export function buildLearningSourceLineageAudit(opts: BuildSourceLineageAuditOptions): SourceLineageAuditReport {
  const diagnostics: SourceLineageDiagnostic[] = [];
  const records: SourceLineageAuditRecord[] = [];

  collectDevMemory(opts.projectRoot, opts.store, records, diagnostics);
  collectFindingSignals(opts.projectRoot, records, diagnostics);
  collectRawFindings(opts.store, records, diagnostics);
  collectProposals(opts.projectRoot, records, diagnostics);
  const playbooks = collectPlaybooks(opts.projectRoot, records, diagnostics);
  collectOutcomes(opts.projectRoot, playbooks, records, diagnostics);
  collectDecisions(opts.projectRoot, records, diagnostics);

  for (const record of records) {
    if (!record.lineagePresent) {
      diagnostic(diagnostics, 'missing_lineage', `${record.artifactKind} ${record.artifactId} has no canonical source lineage`, {
        artifactKind: record.artifactKind,
        artifactId: record.artifactId,
        path: record.sourceRef,
      });
    }
  }

  records.sort((a, b) => {
    const keyA = `${a.canonicalSourceKey ?? ''}:${a.artifactKind}:${a.artifactId}`;
    const keyB = `${b.canonicalSourceKey ?? ''}:${b.artifactKind}:${b.artifactId}`;
    return keyA.localeCompare(keyB);
  });

  return {
    schemaVersion: SOURCE_LINEAGE_AUDIT_SCHEMA_VERSION,
    domain: 'learning',
    auditedAt: opts.now ?? new Date().toISOString(),
    canonicalSourceKey: 'audit:learning',
    canonicalSourceKeyVersion: SOURCE_LINEAGE_CANONICAL_KEY_VERSION,
    canonicalizationPolicyHash: SOURCE_LINEAGE_CANONICALIZATION_POLICY_HASH,
    sourceRecordCount: records.length,
    missingLineageCount: records.filter((record) => !record.lineagePresent).length,
    duplicateCanonicalSourceGroups: duplicateGroups(records),
    records,
    diagnostics,
    authority: 'non_authoritative',
    gateEvidence: false,
  };
}

export function renderSourceLineageAuditReport(report: SourceLineageAuditReport): string {
  return [
    `Source lineage audit (${report.domain})`,
    `authority: ${report.authority}`,
    `gateEvidence: ${report.gateEvidence}`,
    `canonicalSourceKeyVersion: ${report.canonicalSourceKeyVersion}`,
    `canonicalizationPolicyHash: ${report.canonicalizationPolicyHash}`,
    `records: ${report.sourceRecordCount}`,
    `missingLineageCount: ${report.missingLineageCount}`,
    `duplicateCanonicalSourceGroups: ${report.duplicateCanonicalSourceGroups.length}`,
    ...report.duplicateCanonicalSourceGroups.map((group) =>
      `  - ${group.canonicalSourceKey} records=${group.recordCount} ` +
      group.records.map((record) => `${record.artifactKind}:${record.artifactId}`).join(', '),
    ),
    `diagnostics: ${report.diagnostics.length}`,
    ...report.diagnostics.map((item) => `  - [${item.severity}] ${item.code}: ${item.message}${item.path ? ` (${item.path})` : ''}`),
    '(read-only audit only; no seed proposal, approval, promotion, settlement default, or runtime blocking)',
  ].join('\n');
}
