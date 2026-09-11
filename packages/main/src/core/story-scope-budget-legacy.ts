import { realpathSync, lstatSync, readdirSync, type Stats } from 'node:fs';
import { join } from 'node:path';
/** Exact project-governance migration. This is not a signed large-Story approval. */
import { canonicalDigest } from './authority-signing.js';
import type { StoryStore } from './store.js';
import type { ScopeBudgetSubject } from './story-scope-budget.js';

export const SCOPE_BUDGET_LEGACY_SCHEMA = 'story-scope-budget-legacy.v1' as const;
export const SCOPE_BUDGET_SUBJECT_SCHEMA = 'story-scope-budget-subject.v2' as const;
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
export function scopeBudgetSubjectProjection(subject: ScopeBudgetSubject, createdAt: unknown, projectRoot: string) {
  // Preserve unknown/future fields by default. Only explicit execution progress
  // is excluded; withdrawals remain part of the accepted subject.
  const checklist = record(subject.checklist) ? {
    ...without(subject.checklist, ['auditLog']) as Record<string, unknown>,
    ...(Array.isArray(subject.checklist.items) ? { items: subject.checklist.items.map(item => {
      const projected = without(item, ['status', 'startTime', 'endTime', 'verificationEvidence', 'userSeesSnapshot']);
      return { fields: projected, withdrawn: item.status === 'withdrawn' };
    }) } : {}),
  } : subject.checklist;
  let pathSet: ReturnType<typeof legacyScopePathExpansion> | undefined;
  // Unsafe/incomplete legacy inputs remain inspectable, but never receive usable
  // expansion evidence. The matcher below independently requires a valid set.
  try { pathSet = legacyScopePathExpansion(subject, projectRoot); } catch { /* audit-only snapshot */ }
  return { schemaVersion: SCOPE_BUDGET_SUBJECT_SCHEMA, pathSet: pathSet ? { status: 'valid' as const, ...pathSet } : { status: 'invalid' as const }, value: exactValue({ storyId: subject.storyId, createdAt,
    scope: without(subject.scope, ['createdAt', 'updatedAt']), checklist,
    proofStory: without(subject.proofStory, ['createdAt', 'updatedAt']),
  }) };
}
export function readScopeBudgetLegacySnapshot(store: StoryStore, storyId: string) {
  const story = store.readStory(storyId);
  const subject = { storyId, scope: store.readScopeContract(storyId), checklist: store.readChecklist(storyId),
    proofStory: store.readProofStoryContract(storyId) } as ScopeBudgetSubject;
  const projection = scopeBudgetSubjectProjection(subject, story.createdAt, store.projectRoot);
  const pathsSafe = projection.pathSet.status === 'valid';
  return { schemaVersion: SCOPE_BUDGET_SUBJECT_SCHEMA, storyId, createdAt: story.createdAt, phase: story.phase,
    eligibleForMigration: pathsSafe && eligiblePhase(story.phase) && typeof story.createdAt === 'string' && Number.isFinite(Date.parse(story.createdAt)),
    subjectDigest: canonicalDigest(projection), projection };
}
/** Narrow migration grammar: only a literal nonempty prefix followed by /**.
 * This is an exact historical snapshot, never a general glob evaluator.
 */
export function legacyScopePathExpansion(subject: ScopeBudgetSubject, root: string) {
  const canonicalRoot=realpathSync(root);
  if (!lstatSync(canonicalRoot).isDirectory()) throw new Error('legacy scope project root is not a directory');
  const scope = subject.scope, checklist = subject.checklist;
  if (!scope || !checklist || !Array.isArray(checklist.items)) throw new Error('legacy scope subject paths unavailable');
  const lists: unknown[] = [scope.allowedModify, scope.allowedCreate, scope.allowedTest];
  for (const item of checklist.items) {
    if (item.status === 'withdrawn') continue;
    if (item.files !== undefined) {
      if (!record(item.files)) throw new Error('invalid legacy checklist files');
      lists.push(item.files.modify, item.files.create, item.files.test);
    }
  }
  const patterns = new Set<string>();
  const directoryAnchors = new Map<string, Stats>();
  directoryAnchors.set(canonicalRoot, lstatSync(canonicalRoot));
  const literal = (path: string): boolean => Boolean(path) && path === path.trim() && !path.startsWith('/') && !/^[A-Za-z]:/.test(path)
    && !path.includes(String.fromCharCode(92)) && !path.split('/').some(part => !part || part === '.' || part === '..') && ![...path].some(char => '*?[]{}'.includes(char) || char.charCodeAt(0) < 32);
  const inspect = (path: string, requireDirectory: boolean) => {
    const parts = path.split('/'); let current = canonicalRoot;
    for (let index=0; index<parts.length; index++) {
      current = join(current, parts[index]!);
      let stat;
      try { stat=lstatSync(current); } catch(error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT' && !requireDirectory) return;
        throw error;
      }
      if (stat.isSymbolicLink()) throw new Error('symlink in legacy scope: '+path);
      if (stat.isDirectory()) directoryAnchors.set(current, stat);
      if (index<parts.length-1 && !stat.isDirectory()) throw new Error('non-directory legacy prefix');
      if (index===parts.length-1 && (requireDirectory ? !stat.isDirectory() : !stat.isFile())) throw new Error('invalid legacy scope leaf');
    }
  };
  for (const list of lists) {
    if (!Array.isArray(list)) throw new Error('invalid legacy path list');
    for (const value of list) {
      if (typeof value !== 'string') throw new Error('invalid legacy scope path');
      if (value.endsWith('/**')) {
        const prefix=value.slice(0,-3);
        if (!literal(prefix)) throw new Error('unsupported or unbounded legacy scope glob');
        inspect(prefix,true); patterns.add(value);
      } else { if (!literal(value)) throw new Error('unsupported legacy scope path or glob'); inspect(value,false); }
    }
  }
  let visited=0;
  const expansions=[...patterns].sort().map(pattern=>{
    const prefix=pattern.slice(0,-3),paths: Array<{path:string;kind:'directory'|'file'}>=[];
    const walk=(path:string,depth:number)=>{
      if(++visited>10000 || depth>32) throw new Error('legacy scope expansion exceeds bounded traversal');
      const absolute=join(canonicalRoot,path),before=lstatSync(absolute);
      if(before.isSymbolicLink()) throw new Error('symlink in legacy scope expansion');
      if(before.isDirectory()){
        paths.push({path,kind:'directory'});
        for(const name of readdirSync(absolute).sort()){
          if(!literal(name)) throw new Error('malformed legacy filesystem name');
          walk(path+'/'+name,depth+1);
        }
        const after=lstatSync(absolute);
        if(!after.isDirectory() || after.isSymbolicLink() || before.dev!==after.dev || before.ino!==after.ino || before.mtimeMs!==after.mtimeMs || before.ctimeMs!==after.ctimeMs) throw new Error('legacy scope directory changed during expansion');
      }else if(before.isFile())paths.push({path,kind:'file'});
      else throw new Error('unsupported legacy scope filesystem entry');
    };
    walk(prefix,0);return{pattern,paths};
  });
  if (realpathSync(root) !== canonicalRoot) throw new Error('legacy scope input root changed during expansion');
  // Recheck literal ancestors too: replacing a parent after its initial lstat
  // must not turn an outside directory into migration authority.
  for (const [path, before] of directoryAnchors) {
    const after = lstatSync(path);
    if (!after.isDirectory() || after.isSymbolicLink() || before.dev !== after.dev
      || before.ino !== after.ino || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
      throw new Error('legacy scope ancestor changed during expansion');
    }
  }
  return {schemaVersion:'story-scope-budget-legacy-path-set.v1',expansions};
}
export function matchesLegacyScopeBudgetSubject(store: StoryStore, root: string, storyId: string, manifest: ScopeBudgetLegacyManifest,
  next?: ScopeBudgetSubject, base?: ScopeBudgetSubject): boolean {
  try {
  const canonicalRoot = realpathSync(root);
  if (canonicalRoot !== realpathSync(store.projectRoot)) return false;
  const rootIdentity = lstatSync(canonicalRoot);
  const snapshot = readScopeBudgetLegacySnapshot(store, storyId);
  if (snapshot.projection.pathSet.status !== 'valid') return false;
  // Captured eligibility is pinned in trusted project policy. A later authorized
  // return to PLAN must not erase that identity; terminal/INIT states do not use it.
  if (!['INIT_CHECK', 'PLAN', 'DEV', 'REVIEW', 'TEST'].includes(String(snapshot.phase))) return false;
  const entry = manifest.entries.find(row => row.storyId === storyId && row.createdAt === snapshot.createdAt);
  if (!entry || entry.subjectDigest !== snapshot.subjectDigest) return false;
  // The journal cannot borrow a current-base exception for a different proposed
  // subject, or match an old base while the actual persisted scope has drifted.
  const matches = [next, base].every(subject => {
    if (!subject) return true;
    const projection = scopeBudgetSubjectProjection(subject, snapshot.createdAt, root);
    return projection.pathSet.status === 'valid' && canonicalDigest(projection) === entry.subjectDigest;
  });
  if (!matches || realpathSync(root) !== canonicalRoot || realpathSync(store.projectRoot) !== canonicalRoot) return false;
  const currentRoot = lstatSync(canonicalRoot);
  return currentRoot.isDirectory() && !currentRoot.isSymbolicLink()
    && currentRoot.dev === rootIdentity.dev && currentRoot.ino === rootIdentity.ino;
  } catch { return false; }
}
