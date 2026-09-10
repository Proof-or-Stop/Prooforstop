import { existsSync, realpathSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { canonicalFilesystemPath } from './keyed-scheduler.js';
/** Exact project-governance migration. This is not a signed large-Story approval. */
import { canonicalDigest } from './authority-signing.js';
import type { StoryStore } from './store.js';
import type { ScopeBudgetSubject } from './story-scope-budget.js';

export const SCOPE_BUDGET_LEGACY_SCHEMA = 'story-scope-budget-legacy.v1' as const;
export const SCOPE_BUDGET_SUBJECT_SCHEMA = 'story-scope-budget-subject.v1' as const;
export interface ScopeBudgetLegacyManifest {
  schemaVersion: typeof SCOPE_BUDGET_LEGACY_SCHEMA;
  activationSourceCommit: string;
  entries: Array<{ storyId: string; createdAt: string; capturedPhase: 'DEV' | 'REVIEW' | 'TEST'; subjectDigest: string }>;
}
const eligiblePhase = (phase: unknown): boolean => ['DEV', 'REVIEW', 'TEST'].includes(String(phase));
const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
function exactKeys(value: Record<string, unknown>, keys: string[], label: string): void {
  if (Object.keys(value).some(key => !keys.includes(key)) || keys.some(key => !Object.hasOwn(value, key))) throw new Error(`invalid ${label} fields`);
}
export function validateScopeBudgetLegacyManifest(value: unknown): ScopeBudgetLegacyManifest | undefined {
  if (value === undefined) return undefined;
  if (!record(value)) throw new Error('invalid legacy scope budget manifest');
  exactKeys(value, ['schemaVersion', 'activationSourceCommit', 'entries'], 'legacy scope budget manifest');
  if (value.schemaVersion !== SCOPE_BUDGET_LEGACY_SCHEMA || typeof value.activationSourceCommit !== 'string'
    || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value.activationSourceCommit) || !Array.isArray(value.entries)) throw new Error('invalid legacy scope budget manifest identity');
  const seen = new Set<string>();
  for (const entry of value.entries) {
    if (!record(entry)) throw new Error('invalid legacy scope budget entry');
    exactKeys(entry, ['storyId', 'createdAt', 'capturedPhase', 'subjectDigest'], 'legacy scope budget entry');
    if (!eligiblePhase(entry.capturedPhase) || typeof entry.storyId !== 'string' || !entry.storyId.trim() || entry.storyId !== entry.storyId.trim() || seen.has(entry.storyId)
      || typeof entry.createdAt !== 'string' || !entry.createdAt.trim() || !Number.isFinite(Date.parse(entry.createdAt))
      || typeof entry.subjectDigest !== 'string' || !/^[a-f0-9]{64}$/.test(entry.subjectDigest)) throw new Error('invalid or duplicate legacy scope budget entry identity');
    seen.add(entry.storyId);
  }
  return value as unknown as ScopeBudgetLegacyManifest;
}
/** Tagged representation preserves absent/null/empty and explicit undefined distinctly. */
function exactValue(value: unknown): unknown {
  if (value === undefined) return { kind: 'undefined' };
  if (value === null) return { kind: 'null' };
  if (Array.isArray(value)) return { kind: 'array', values: value.map(exactValue) };
  if (record(value)) return { kind: 'object', entries: Object.keys(value).sort().map(key => [key, exactValue(value[key])]) };
  if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('nonfinite scope subject value');
  if (!['string', 'number', 'boolean'].includes(typeof value)) throw new Error('unsupported scope subject value');
  return { kind: typeof value, value };
}
function without(value: unknown, keys: string[]): unknown {
  if (!record(value)) return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => !keys.includes(key)));
}
export function scopeBudgetSubjectProjection(subject: ScopeBudgetSubject, createdAt: unknown): unknown {
  // Preserve unknown/future fields by default. Only explicit execution progress
  // is excluded; withdrawals remain part of the accepted subject.
  const checklist = record(subject.checklist) ? {
    ...without(subject.checklist, ['auditLog']) as Record<string, unknown>,
    ...(Array.isArray(subject.checklist.items) ? { items: subject.checklist.items.map(item => {
      const projected = without(item, ['status', 'startTime', 'endTime', 'verificationEvidence', 'userSeesSnapshot']);
      return { fields: projected, withdrawn: item.status === 'withdrawn' };
    }) } : {}),
  } : subject.checklist;
  return { schemaVersion: SCOPE_BUDGET_SUBJECT_SCHEMA, value: exactValue({ storyId: subject.storyId, createdAt,
    scope: without(subject.scope, ['createdAt', 'updatedAt']), checklist,
    proofStory: without(subject.proofStory, ['createdAt', 'updatedAt']),
  }) };
}
export function readScopeBudgetLegacySnapshot(store: StoryStore, storyId: string) {
  const story = store.readStory(storyId);
  const subject = { storyId, scope: store.readScopeContract(storyId), checklist: store.readChecklist(storyId),
    proofStory: store.readProofStoryContract(storyId) } as ScopeBudgetSubject;
  const projection = scopeBudgetSubjectProjection(subject, story.createdAt);
  return { schemaVersion: SCOPE_BUDGET_SUBJECT_SCHEMA, storyId, createdAt: story.createdAt, phase: story.phase,
    eligibleForMigration: eligiblePhase(story.phase) && typeof story.createdAt === 'string' && Number.isFinite(Date.parse(story.createdAt)),
    subjectDigest: canonicalDigest(projection), projection };
}
/** Independent of subjectFacts: missing topology must not suppress path safety. */
function legacySubjectPathsSafe(store: StoryStore, root: string, storyId: string): boolean {
  try {
    const scope = store.readScopeContract(storyId), checklist = store.readChecklist(storyId);
    if (!scope || !Array.isArray(checklist.items)) return false;
    const lists: unknown[] = [scope.allowedModify, scope.allowedCreate, scope.allowedTest];
    for (const item of checklist.items) {
      if (item.status === 'withdrawn') continue;
      if (item.files !== undefined) {
        if (!item.files || typeof item.files !== 'object') return false;
        lists.push(item.files.modify, item.files.create, item.files.test);
      }
    }
    const canonicalRoot = realpathSync(root);
    for (const list of lists) {
      if (!Array.isArray(list)) return false;
      for (const path of list) {
        if (typeof path !== 'string' || !path || path !== path.trim() || path.startsWith('/')
          || /^[A-Za-z]:/.test(path) || path.includes('\\') || path.split('/').some(part => !part || part === '.' || part === '..')
          || /[*?[\]{}\x00-\x1f]/.test(path)) return false;
        const actual = canonicalFilesystemPath(root, path);
        if (actual !== resolve(canonicalRoot, path) || (existsSync(actual) && statSync(actual).isDirectory())) return false;
      }
    }
    return true;
  } catch { return false; }
}
export function matchesLegacyScopeBudgetSubject(store: StoryStore, root: string, storyId: string, manifest: ScopeBudgetLegacyManifest,
  next?: ScopeBudgetSubject, base?: ScopeBudgetSubject): boolean {
  if (!legacySubjectPathsSafe(store, root, storyId)) return false;
  const snapshot = readScopeBudgetLegacySnapshot(store, storyId);
  // Captured eligibility is pinned in trusted project policy. A later authorized
  // return to PLAN must not erase that identity; terminal/INIT states do not use it.
  if (!['INIT_CHECK', 'PLAN', 'DEV', 'REVIEW', 'TEST'].includes(String(snapshot.phase))) return false;
  const entry = manifest.entries.find(row => row.storyId === storyId && row.createdAt === snapshot.createdAt);
  if (!entry || entry.subjectDigest !== snapshot.subjectDigest) return false;
  // The journal cannot borrow a current-base exception for a different proposed
  // subject, or match an old base while the actual persisted scope has drifted.
  return [next, base].every(subject => !subject || canonicalDigest(scopeBudgetSubjectProjection(subject, snapshot.createdAt)) === entry.subjectDigest);
}
