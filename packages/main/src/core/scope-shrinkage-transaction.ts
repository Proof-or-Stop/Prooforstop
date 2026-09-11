import { resolveGitCwd } from './story-signed-workspace-resolution.js';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { StoryStore } from './store.js';
import type { ChecklistData } from './types.js';
import { digestCanonicalJson } from './digest.js';
import { readIntentCheckpoint } from './verification-intent-checkpoint.js';
import { withValidationMetadataWrite } from './validation-execution-lock.js';

const files = ['scope-shrinkage-decision.json', 'checklist.json', 'proofstory.json'] as const;
type File = typeof files[number];
const digest = (value: Buffer | null): string | null => value === null ? null : createHash('sha256').update(value).digest('hex');
const bytes = (path: string): Buffer | null => existsSync(path) ? readFileSync(path) : null;
function head(root: string): string | null {
  try { return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(); }
  catch { return null; }
}
/** Bounded scope withdrawal only: amendments never change here. Compensation
 * appends a signed checkpoint generation, never rewinds its audit history.
 * Captures canonical outputs only; callers must already have an existing Story.
 * Changing amendment history would trigger AMENDMENT_HISTORY_REMOVAL_REFUSED.
 * Cooperative exclusion and byte checks are not OS-wide atomicity. */
export function withScopeShrinkageTransaction<T>(root: string, store: StoryStore, storyId: string,
  apply: (tx: { write(file: File, data: unknown, writer: () => void): void }) => T): T {
  return withValidationMetadataWrite(store.projectRoot, storyId, () => {
    const path = (file: File) => store.storyFilePath(storyId, file);
    const regular = (file: File): boolean => {
      const parts = relative(root, path(file)).split('/');
      if (parts.includes('..')) return false;
      for (let i = 1; i <= parts.length; i++) {
        try {
          const entry = lstatSync(join(root, ...parts.slice(0, i)));
          if (entry.isSymbolicLink() || (i === parts.length ? !entry.isFile() : !entry.isDirectory())) return false;
        } catch (error) {
          return i === parts.length && (error as NodeJS.ErrnoException).code === 'ENOENT';
        }
      }
      return true;
    };
    const before = new Map<File, Buffer | null>();
    for (const file of files) {
      if (!regular(file)) throw new Error(`SCOPE_WITHDRAWAL_NONREGULAR_PATH: ${file}`);
      before.set(file, bytes(path(file)));
    }
    const checkpointCwd = store.storyDirPath(storyId);
    const tipBefore = readIntentCheckpoint(storyId, checkpointCwd);
    let headCwd = root;
    try { headCwd = resolveGitCwd({ store: new StoryStore(root), storyId, metadataRoot: root, projectRoot: root }); } catch { /* Match metadata publisher fallback. */ }
    const headBefore = head(headCwd);
    const expected = new Map<File, string | null>();
    let intendedChecklist: ChecklistData | undefined;
    try {
      return apply({ write(file, data, writer) {
        if (!regular(file)) throw new Error(`SCOPE_WITHDRAWAL_NONREGULAR_PATH: ${file}`);
        expected.set(file, digest(Buffer.from(JSON.stringify(data, null, 2) + '\n')));
        if (file === 'checklist.json') intendedChecklist = structuredClone(data) as ChecklistData;
        writer();
        if (!regular(file) || digest(bytes(path(file))) !== expected.get(file)) throw new Error(`SCOPE_WITHDRAWAL_OUTPUT_CHANGED: ${file}`);
      } });
    } catch (error) {
      const failures: string[] = [];
      if (head(headCwd) !== headBefore) throw new Error(`SCOPE_WITHDRAWAL_RECOVERY_REQUIRED: HEAD changed; preserve committed state; ${String(error)}`);
      let preserveChecklist = false;
      try {
        const tipAfter = readIntentCheckpoint(storyId, checkpointCwd);
        if (digestCanonicalJson(tipAfter) !== digestCanonicalJson(tipBefore)) {
          preserveChecklist = true;
          const baseline = before.get('checklist.json');
          const current = regular('checklist.json') ? bytes(path('checklist.json')) : null;
          if (baseline && current && tipAfter && intendedChecklist
            && tipAfter.dataDigest === digestCanonicalJson(intendedChecklist)
            && tipAfter.generation === (tipBefore?.generation ?? 0) + 1
            && tipAfter.previousDigest === (tipBefore?.dataDigest ?? null)
            && digest(current) === expected.get('checklist.json')
            && tipAfter.dataDigest === digestCanonicalJson(JSON.parse(current.toString()))) {
            const original = JSON.parse(baseline.toString()) as ChecklistData;
            let compensationError: unknown;
            try { store.writeChecklist(storyId, original); } catch (caught) { compensationError = caught; }
            const compensated = readIntentCheckpoint(storyId, checkpointCwd);
            if (!regular('checklist.json') || digest(bytes(path('checklist.json'))) !== digest(baseline)
              || compensated?.dataDigest !== digestCanonicalJson(original)) {
              throw new Error(`checkpoint compensation incomplete: ${String(compensationError ?? 'projection mismatch')}`);
            }
          } else throw new Error('checkpoint advanced without the intended complete projection; use verification_intent_recover');
        }
      } catch (caught) { preserveChecklist = true; failures.push(String(caught)); }
      for (const file of files) {
        if (file === 'checklist.json' && preserveChecklist) continue;
        try {
          if (!regular(file)) throw new Error('foreign nonregular path preserved');
          const baseline = before.get(file) ?? null;
          const current = bytes(path(file));
          if (digest(current) === digest(baseline)) continue;
          if (!expected.has(file) || digest(current) !== expected.get(file)) throw new Error('foreign bytes preserved');
          if (baseline === null) rmSync(path(file), { force: true });
          else writeFileSync(path(file), baseline);
        } catch (caught) { failures.push(`${file}: ${String(caught)}`); }
      }
      if (failures.length) throw new Error(`SCOPE_WITHDRAWAL_RECOVERY_REQUIRED: ${String(error)}; ${failures.join('; ')}`);
      throw error;
    }
  });
}
