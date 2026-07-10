import { isAbsolute, relative } from 'node:path';
import { posix } from 'node:path';
import { digestCanonicalJson } from './digest.js';
import type {
  ReviewerReadDiagnostic,
  ReviewerReadLogEvent,
  ReviewerReadLogEvidence,
  ReviewerReadManifest,
} from './types.js';

export interface ReviewerReadLogOptions {
  projectRoot?: string;
  requirementsDir?: string;
}

export interface ReviewerReadCaptureContext extends ReviewerReadLogOptions {
  agent?: string | null;
}

type ReadMode = ReviewerReadLogEvent['mode'];

const DEFAULT_REQUIREMENTS_DIR = 'docs/requirements';
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

function isReviewerAgent(agent: unknown): agent is string {
  return typeof agent === 'string' && agent.startsWith('lattice-review-');
}

function rejectPath(label: string, reason: string, value: unknown): never {
  throw new Error(`${label}: ${reason} (${JSON.stringify(value)})`);
}

function normalizeRelativePath(value: unknown, label: string): string {
  if (typeof value !== 'string') rejectPath(label, 'path must be a string', value);
  const raw = value.trim();
  if (!raw) rejectPath(label, 'path must be non-empty', value);
  if (CONTROL_CHARS.test(raw)) rejectPath(label, 'path contains control characters', value);
  if (raw.includes('\\')) rejectPath(label, 'path must use POSIX / separators', value);
  if (isAbsolute(raw) || /^[A-Za-z]:[\\/]/.test(raw)) rejectPath(label, 'absolute paths are not allowed', value);
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(raw)) rejectPath(label, 'URL paths are not allowed', value);
  if (raw.startsWith('~')) rejectPath(label, 'home-relative paths are not allowed', value);
  const normalized = posix.normalize(raw);
  if (normalized === '.' || normalized === '..' || normalized.startsWith('../') || normalized.includes('/../')) {
    rejectPath(label, 'path traversal is not allowed', value);
  }
  return normalized.replace(/^\.\//, '');
}

function normalizeManifestPathArray(input: unknown, field: keyof ReviewerReadManifest, label: string): string[] {
  if (!Array.isArray(input)) {
    throw new Error(`${label}.${field}: must be an array of relative file paths`);
  }
  const seen = new Set<string>();
  const normalized = input.map((item, idx) => {
    const rel = normalizeRelativePath(item, `${label}.${field}[${idx}]`);
    if (seen.has(rel)) {
      throw new Error(`${label}.${field}: duplicate path ${rel}`);
    }
    seen.add(rel);
    return rel;
  });
  return normalized.sort((a, b) => a.localeCompare(b));
}

export function normalizeReviewerReadManifest(input: unknown, label = 'readManifest'): ReviewerReadManifest {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error(`${label}: must be an object with filesReadFully, filesTriagedByName, and scanEscalationReason`);
  }
  const record = input as Record<string, unknown>;
  if (!Object.prototype.hasOwnProperty.call(record, 'filesReadFully')) {
    throw new Error(`${label}.filesReadFully: missing required array`);
  }
  if (!Object.prototype.hasOwnProperty.call(record, 'filesTriagedByName')) {
    throw new Error(`${label}.filesTriagedByName: missing required array`);
  }
  if (!Object.prototype.hasOwnProperty.call(record, 'scanEscalationReason')) {
    throw new Error(`${label}.scanEscalationReason: missing required string|null`);
  }

  const filesReadFully = normalizeManifestPathArray(record.filesReadFully, 'filesReadFully', label);
  const filesTriagedByName = normalizeManifestPathArray(record.filesTriagedByName, 'filesTriagedByName', label);
  const all = new Set(filesReadFully);
  for (const path of filesTriagedByName) {
    if (all.has(path)) {
      throw new Error(`${label}: duplicate path ${path} appears in both filesReadFully and filesTriagedByName`);
    }
    all.add(path);
  }

  let scanEscalationReason: string | null;
  if (record.scanEscalationReason === null) {
    scanEscalationReason = null;
  } else if (typeof record.scanEscalationReason === 'string') {
    const trimmed = record.scanEscalationReason.trim();
    if (!trimmed) {
      throw new Error(`${label}.scanEscalationReason: use null when there is no escalation reason; blank strings are malformed`);
    }
    scanEscalationReason = trimmed;
  } else {
    throw new Error(`${label}.scanEscalationReason: must be a string or null`);
  }

  return { filesReadFully, filesTriagedByName, scanEscalationReason };
}

export function digestReviewerReadManifest(manifest: ReviewerReadManifest): string {
  return digestCanonicalJson({
    version: 1,
    readManifest: normalizeReviewerReadManifest(manifest),
  });
}

function normalizeRequirementsDir(requirementsDir: string | undefined): string {
  return normalizeRelativePath(requirementsDir || DEFAULT_REQUIREMENTS_DIR, 'requirementsDir');
}

function normalizeReadLogPath(value: unknown, options: ReviewerReadLogOptions, label: string): string {
  if (typeof value !== 'string') rejectPath(label, 'path must be a string', value);
  let raw = value.trim();
  if (isAbsolute(raw)) {
    if (!options.projectRoot) rejectPath(label, 'absolute paths require projectRoot for relativization', value);
    const rel = relative(options.projectRoot, raw).replace(/\\/g, '/');
    if (rel.startsWith('../') || rel === '..' || isAbsolute(rel)) {
      rejectPath(label, 'absolute path is outside projectRoot', value);
    }
    raw = rel;
  }
  return normalizeRelativePath(raw, label);
}

export function isDecisionMarkdownPath(path: string, options: ReviewerReadLogOptions = {}): boolean {
  const requirementsDir = normalizeRequirementsDir(options.requirementsDir);
  const prefix = `${requirementsDir}/decisions/`;
  if (!path.startsWith(prefix) || !path.endsWith('.md')) return false;
  const rest = path.slice(prefix.length);
  return rest.length > 0 && !rest.includes('/');
}

function rawPathFromEvent(input: Record<string, unknown>): unknown {
  return input.path ?? input.filePath ?? input.file ?? input.absolutePath ?? input.relPath;
}

function readModeFromEvent(input: Record<string, unknown>): ReadMode {
  if (input.readFully === false) return 'triage';
  if (input.readFully === true) return 'full';
  const raw = input.mode ?? input.action ?? input.kind ?? input.readType;
  if (typeof raw === 'string') {
    const mode = raw.trim().toLowerCase();
    if (['triage', 'triaged', 'filename', 'name', 'list', 'glob'].includes(mode)) return 'triage';
    if (['full', 'read', 'readfull', 'read_full', 'tool:read', 'read-tool'].includes(mode)) return 'full';
  }
  return 'full';
}

function tokenCountFromEvent(input: Record<string, unknown>): number | null {
  const raw = input.tokenCount ?? input.tokens;
  if (raw === undefined || raw === null) return null;
  if (typeof raw === 'number' && Number.isFinite(raw) && raw >= 0) return Math.trunc(raw);
  return null;
}

export function captureReviewerReadEvent(
  input: unknown,
  context: ReviewerReadCaptureContext = {},
): ReviewerReadLogEvent | null {
  if (!isReviewerAgent(context.agent)) return null;
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('read event: must be an object');
  }
  const record = input as Record<string, unknown>;
  const path = normalizeReadLogPath(rawPathFromEvent(record), context, 'read event.path');
  if (!isDecisionMarkdownPath(path, context)) return null;
  return {
    path,
    mode: readModeFromEvent(record),
    tokenCount: tokenCountFromEvent(record),
    agent: context.agent!,
  };
}

export function normalizeReviewerReadLog(events: readonly ReviewerReadLogEvent[]): ReviewerReadLogEvidence {
  const full = new Set<string>();
  const triage = new Set<string>();
  const fullEvents: Array<{ path: string; mode: ReadMode; tokenCount: number | null }> = [];
  const digestEvents: Array<{ path: string; mode: ReadMode; tokenCount: number | null }> = [];

  for (const event of events) {
    const path = normalizeRelativePath(event.path, 'readLog.event.path');
    const mode = event.mode === 'triage' ? 'triage' : 'full';
    const tokenCount = typeof event.tokenCount === 'number' && Number.isFinite(event.tokenCount) && event.tokenCount >= 0
      ? Math.trunc(event.tokenCount)
      : null;
    if (mode === 'full') {
      full.add(path);
      fullEvents.push({ path, mode, tokenCount });
    } else {
      triage.add(path);
    }
    digestEvents.push({ path, mode, tokenCount });
  }

  const filesReadFully = [...full].sort((a, b) => a.localeCompare(b));
  const filesTriagedByName = [...triage]
    .filter(path => !full.has(path))
    .sort((a, b) => a.localeCompare(b));
  const hasCompleteTokenCounts = fullEvents.length > 0 && fullEvents.every(event => event.tokenCount !== null);
  const tokenCount = hasCompleteTokenCounts
    ? fullEvents.reduce((sum, event) => sum + (event.tokenCount ?? 0), 0)
    : null;
  const summary = {
    readCount: fullEvents.length,
    tokenCount,
  };
  const normalizedDigestEvents = digestEvents.sort((a, b) =>
    `${a.mode}:${a.path}:${a.tokenCount ?? 'null'}`.localeCompare(`${b.mode}:${b.path}:${b.tokenCount ?? 'null'}`),
  );
  const digest = digestCanonicalJson({
    version: 1,
    filesReadFully,
    filesTriagedByName,
    summary,
    events: normalizedDigestEvents,
  });
  return { filesReadFully, filesTriagedByName, summary, digest };
}

function addSetDiagnostics(
  diagnostics: ReviewerReadDiagnostic[],
  expected: readonly string[],
  actual: readonly string[],
  missingCode: ReviewerReadDiagnostic['code'],
  extraCode: ReviewerReadDiagnostic['code'],
  missingMessage: string,
  extraMessage: string,
): void {
  const expectedSet = new Set(expected);
  const actualSet = new Set(actual);
  for (const path of [...expectedSet].sort((a, b) => a.localeCompare(b))) {
    if (!actualSet.has(path)) {
      diagnostics.push({ code: missingCode, severity: 'finding', path, message: `${missingMessage}: ${path}` });
    }
  }
  for (const path of [...actualSet].sort((a, b) => a.localeCompare(b))) {
    if (!expectedSet.has(path)) {
      diagnostics.push({ code: extraCode, severity: 'finding', path, message: `${extraMessage}: ${path}` });
    }
  }
}

export function diagnoseReviewerReadEvidence(args: {
  readManifest: ReviewerReadManifest;
  readLog: ReviewerReadLogEvidence;
  knownDecisionFiles?: string[];
  requirementsDir?: string;
}): ReviewerReadDiagnostic[] {
  const readManifest = normalizeReviewerReadManifest(args.readManifest);
  const diagnostics: ReviewerReadDiagnostic[] = [];
  addSetDiagnostics(
    diagnostics,
    args.readLog.filesReadFully,
    readManifest.filesReadFully,
    'read_manifest_missing_full_read',
    'read_manifest_extra_full_read',
    'mechanical read log has a full read missing from readManifest.filesReadFully',
    'readManifest.filesReadFully self-reports a file absent from the mechanical read log',
  );
  addSetDiagnostics(
    diagnostics,
    args.readLog.filesTriagedByName,
    readManifest.filesTriagedByName,
    'read_manifest_missing_triage',
    'read_manifest_extra_triage',
    'mechanical read log has a triaged file missing from readManifest.filesTriagedByName',
    'readManifest.filesTriagedByName self-reports a file absent from the mechanical read log',
  );

  const knownDecisionFiles = (args.knownDecisionFiles ?? [])
    .map((path, idx) => normalizeRelativePath(path, `knownDecisionFiles[${idx}]`))
    .filter(path => isDecisionMarkdownPath(path, { requirementsDir: args.requirementsDir }))
    .sort((a, b) => a.localeCompare(b));
  const fullyRead = new Set(args.readLog.filesReadFully);
  const fullScanWithoutReason = knownDecisionFiles.length > 0
    && knownDecisionFiles.every(path => fullyRead.has(path))
    && readManifest.scanEscalationReason === null;
  if (fullScanWithoutReason) {
    diagnostics.push({
      code: 'full_scan_without_scanEscalationReason',
      severity: 'finding',
      message: 'Full decisions-doc scan was mechanically observed but readManifest.scanEscalationReason is null',
    });
  }
  return diagnostics;
}
