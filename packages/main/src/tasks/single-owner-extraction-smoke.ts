#!/usr/bin/env node
/**
 * B-41c8 — single-owner extraction smoke.
 *
 * One smoke file holds every case for the story's four checklist items. Each
 * item registers ONE case group; the runner prints one line per case and ends
 * with exactly `single-owner-extraction-smoke: PASS` or
 * `single-owner-extraction-smoke: FAIL` (exit 1 on FAIL).
 *
 * CHK-001 — rename-aware diff reader (core/evidence-freshness.ts):
 *   `changedFilesBetweenRenameAware`, `changedFileStatusesBetweenRenameAware`
 *   and `changedStoryFilesBetween` must read `git diff --name-status -M -z`
 *   and parse NUL-separated records. The RED fixtures below fail against the
 *   tab/C-quoted parser because a renamed path containing a space, a
 *   non-ASCII character, or a quote character comes back C-quoted
 *   (`"q\"uote.txt"`, `"\346\227\245\346\234\254.txt"`) instead of as the
 *   plain path, and a malformed record is skipped instead of raising.
 *
 * Contract pinned here (and documented on the reader):
 *   - an unresolvable ref still throws (git exit 128 propagates);
 *   - a record that does not fit `<status> NUL <path> NUL` or
 *     `<R|C>[score] NUL <old> NUL <new> NUL` throws an Error whose message
 *     contains the raw record; no record is skipped;
 *   - no caller in packages/main/src wraps these readers in a
 *     `catch { return [] }` — a shorter list under a success status is the
 *     exact failure mode this story forbids.
 *
 * Injection: git is a subprocess, so the "git output path" is stubbed by
 * prepending a directory with a fake `git` to PATH for the duration of a
 * case. The stub honours `-z` (NUL records) versus no `-z` (tab rows) so the
 * same stub is faithful to whichever command shape the reader issues.
 *
 * CHK-002 — one owner for the legacy command-string parse:
 *   core/done-required-validation.ts delegates its `doneRequiredCommands[]`
 *   string entries to `parseLegacyValidationCommandString`; a committed corpus
 *   with pinned expected tuples proves the DONE-required executor path,
 *   handlers/verifier.ts and the canonical parser agree on every entry, and a
 *   structural case fails if a private parser reappears.
 *
 * CHK-003 — one owner for story workspace resolution:
 *   core/story-workspace.ts `resolveStoryWorkspace` returns gitCwd (from
 *   resolveGitCwd), a workspace-rooted StoryStore, workspace-loaded config and
 *   the source used; story-query.ts, session.ts,
 *   local-assurance-story-projection.ts and validation-plan.ts delegate to it.
 */

import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as freshnessModule from '../core/evidence-freshness.js';
import {
  changedFilesBetweenRenameAware,
  changedFileStatusesBetweenRenameAware,
  currentMaterialHash,
  currentStoryFilesHash,
  isMaterialExcludedPath,
} from '../core/evidence-freshness.js';
import { loadConfig, resetConfigCache } from '../core/config.js';
import { PROOF_OR_STOP_STATE_DIR } from '../core/brand-paths.js';
import { resolveLocalAssuranceStories } from '../core/local-assurance-story-projection.js';
import { StoryStore } from '../core/store.js';
import { resolveGitCwd } from '../core/story-signed-workspace-resolution.js';
import type { ChecklistData, StoryInfo } from '../core/types.js';
import type { HandlerContext } from '../handlers/context.js';
import { createSessionHandlers } from '../handlers/session.js';
import { createStoryQueryHandlers } from '../handlers/story-query.js';
import { createValidationPlanHandlers } from '../handlers/validation-plan.js';
import { resolveDoneRequiredPolicy } from '../core/done-required-validation.js';
import { configuredValidationCommands } from '../handlers/verifier.js';
import { parseLegacyValidationCommandString } from '../core/validation-command-identity.js';

const MARKER = 'single-owner-extraction-smoke';
const HERE = dirname(fileURLToPath(import.meta.url));
// dist/tasks -> packages/main/src (the audited source tree).
const MAIN_SRC = resolve(HERE, '..', '..', 'src');

// ---------------------------------------------------------------------------
// Case runner. Later checklist items append their own group via `group(...)`.
// ---------------------------------------------------------------------------

type SmokeCase = { name: string; run: () => void };
type SmokeGroup = { name: string; cases: SmokeCase[] };
const GROUPS: SmokeGroup[] = [];

function group(name: string, cases: SmokeCase[]): void {
  GROUPS.push({ name, cases });
}

function runAll(): boolean {
  let failed = 0;
  let total = 0;
  for (const g of GROUPS) {
    console.log(`# ${g.name}`);
    for (const c of g.cases) {
      total += 1;
      try {
        c.run();
        console.log(`[PASS] ${c.name}`);
      } catch (error) {
        failed += 1;
        const message = error instanceof Error ? error.message : String(error);
        console.log(`[FAIL] ${c.name}: ${message}`);
      }
    }
  }
  console.log(`${total - failed}/${total} cases passed`);
  return failed === 0;
}

// ---------------------------------------------------------------------------
// Shared fixture helpers.
// ---------------------------------------------------------------------------

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: MARKER,
  GIT_AUTHOR_EMAIL: `${MARKER}@example.com`,
  GIT_COMMITTER_NAME: MARKER,
  GIT_COMMITTER_EMAIL: `${MARKER}@example.com`,
};

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'], env: GIT_ENV });
}

function makeRepo(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), `${MARKER}-${prefix}-`));
  git(root, ['init', '-q']);
  git(root, ['checkout', '-q', '-b', 'main']);
  // Explicitly keep C-quoting ON for the tab format so the RED fixture shows the
  // exact string the old parser reported for a non-ASCII path.
  git(root, ['config', 'core.quotepath', 'true']);
  return root;
}

function withTempDir<T>(prefix: string, fn: (root: string) => T): T {
  const root = makeRepo(prefix);
  try {
    return fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const REAL_GIT = execFileSync('/bin/sh', ['-c', 'command -v git'], { encoding: 'utf-8' }).trim();

/**
 * Runs `fn` with a fake `git` first on PATH. The fake answers `diff` with the
 * supplied records (NUL form when `-z` is present, tab form otherwise) and
 * delegates everything else to the real git.
 */
function withStubbedGitDiff<T>(records: string[][], fn: () => T): T {
  const stubDir = mkdtempSync(join(tmpdir(), `${MARKER}-gitstub-`));
  const nul = records.map(record => record.map(field => field + '\\000').join('')).join('');
  const tab = records.map(record => record.join('\\t') + '\\n').join('');
  const script = [
    '#!/bin/sh',
    'if [ "$1" = "diff" ]; then',
    '  case " $* " in',
    `    *" -z "*) printf '${nul}'; exit 0 ;;`,
    `    *) printf '${tab}'; exit 0 ;;`,
    '  esac',
    'fi',
    `exec "${REAL_GIT}" "$@"`,
    '',
  ].join('\n');
  const stubPath = join(stubDir, 'git');
  writeFileSync(stubPath, script, 'utf-8');
  chmodSync(stubPath, 0o755);
  const originalPath = process.env.PATH;
  process.env.PATH = `${stubDir}:${originalPath ?? ''}`;
  try {
    return fn();
  } finally {
    process.env.PATH = originalPath;
    rmSync(stubDir, { recursive: true, force: true });
  }
}

type StoryFileEntry = { path: string; deleted: boolean };
type ChangedStoryFilesBetween = (gitCwd: string, fromHead: string, toHead?: string) => StoryFileEntry[];
type NameStatusRecord = { status: string; oldPath?: string; path: string };
type ParseNameStatusRecords = (raw: string) => NameStatusRecord[];

/**
 * The RED commit compiles against a reader that does not yet export
 * `changedStoryFilesBetween` / `parseNameStatusRecords`; resolving them through
 * the module namespace keeps the smoke compiling while still failing loudly
 * when the export is absent.
 */
function requireExport<T>(name: string): T {
  const value = (freshnessModule as unknown as Record<string, unknown>)[name];
  if (typeof value !== 'function') {
    throw new Error(`core/evidence-freshness.ts does not export ${name}`);
  }
  return value as T;
}

// ---------------------------------------------------------------------------
// Local REFERENCE implementations: the pre-B-41c8 tab parser and hash formulas,
// copied verbatim, so the parity cases can prove byte-identical hashes over a
// repository with only plain paths.
// ---------------------------------------------------------------------------

const REF_GIT_OPTS = {
  encoding: 'utf-8' as const,
  stdio: ['pipe', 'pipe', 'pipe'] as ['pipe', 'pipe', 'pipe'],
  maxBuffer: 1024 * 1024 * 1024,
};

function referenceChangedFilesBetweenRenameAware(gitCwd: string, fromHead: string, toHead = 'HEAD'): string[] {
  const raw = execFileSync('git', ['diff', '--name-status', '-M', `${fromHead}..${toHead}`], { cwd: gitCwd, ...REF_GIT_OPTS }).trim();
  const paths = new Set<string>();
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const cols = trimmed.split('\t').map(c => c.trim()).filter(Boolean);
    if (cols.length < 2) continue;
    const status = cols[0];
    if ((status.startsWith('R') || status.startsWith('C')) && cols.length >= 3) {
      paths.add(cols[1]);
      paths.add(cols[2]);
    } else {
      paths.add(cols[cols.length - 1]);
    }
  }
  return [...paths].sort();
}

function referenceChangedFileStatusesBetweenRenameAware(gitCwd: string, fromHead: string, toHead = 'HEAD'): Record<string, string> {
  const raw = execFileSync('git', ['diff', '--name-status', '-M', `${fromHead}..${toHead}`], { cwd: gitCwd, ...REF_GIT_OPTS }).trim();
  const statuses: Record<string, string> = {};
  for (const line of raw.split('\n')) {
    const cols = line.trim().split('\t').map(column => column.trim()).filter(Boolean);
    if (cols.length < 2) continue;
    const status = cols[0];
    if ((status.startsWith('R') || status.startsWith('C')) && cols.length >= 3) {
      statuses[cols[1]] = status;
      statuses[cols[2]] = status;
    } else {
      statuses[cols[cols.length - 1]] = status;
    }
  }
  return Object.fromEntries(Object.entries(statuses).sort(([left], [right]) => left.localeCompare(right)));
}

function referenceChangedStoryFilesBetween(gitCwd: string, fromHead: string, toHead = 'HEAD'): StoryFileEntry[] {
  const raw = execFileSync('git', ['diff', '--name-status', '-M', `${fromHead}..${toHead}`], { cwd: gitCwd, ...REF_GIT_OPTS }).trim();
  const files = new Map<string, StoryFileEntry>();
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const cols = trimmed.split('\t').map(c => c.trim()).filter(Boolean);
    if (cols.length < 2) continue;
    const status = cols[0];
    const add = (path: string, deleted: boolean) => {
      const existing = files.get(path);
      files.set(path, { path, deleted: existing ? existing.deleted && deleted : deleted });
    };
    if ((status.startsWith('R') || status.startsWith('C')) && cols.length >= 3) {
      add(cols[1], true);
      add(cols[2], status.startsWith('D'));
    } else {
      add(cols[cols.length - 1], status.startsWith('D'));
    }
  }
  return [...files.values()].sort((a, b) => a.path.localeCompare(b.path));
}

function referenceObjectIdsAtRef(gitCwd: string, ref: string): Map<string, string> {
  const out = new Map<string, string>();
  const raw = execFileSync('git', ['ls-tree', '-r', '-z', ref], { cwd: gitCwd, ...REF_GIT_OPTS });
  for (const entry of raw.split('\0')) {
    if (!entry) continue;
    const tab = entry.indexOf('\t');
    if (tab < 0) continue;
    const meta = entry.slice(0, tab);
    const filePath = entry.slice(tab + 1);
    const objectId = meta.trim().split(/\s+/)[2];
    if (filePath && objectId) out.set(filePath, objectId);
  }
  return out;
}

function referenceStoryFilesHash(gitCwd: string, ref = 'HEAD', metadataRoot: string = gitCwd): string {
  const base = execFileSync('git', ['merge-base', 'main', ref], { cwd: gitCwd, ...REF_GIT_OPTS }).trim();
  const objectIds = referenceObjectIdsAtRef(gitCwd, ref);
  const entries = referenceChangedStoryFilesBetween(gitCwd, base, ref)
    .filter(entry => !isMaterialExcludedPath(entry.path, metadataRoot))
    .map((entry) => {
      const objectId = entry.deleted ? undefined : objectIds.get(entry.path);
      return `${entry.path}\0${objectId || '<deleted>'}`;
    })
    .sort();
  return createHash('sha256').update(entries.join('\0')).digest('hex');
}

function referenceMaterialHash(gitCwd: string, ref = 'HEAD', metadataRoot: string = gitCwd): string {
  const raw = execFileSync('git', ['ls-tree', '-r', '-z', ref], { cwd: gitCwd, ...REF_GIT_OPTS });
  const materialEntries: string[] = [];
  for (const entry of raw.split('\0').filter(Boolean)) {
    const tab = entry.indexOf('\t');
    if (tab < 0) continue;
    const meta = entry.slice(0, tab);
    const filePath = entry.slice(tab + 1);
    if (isMaterialExcludedPath(filePath, metadataRoot)) continue;
    const objectId = meta.trim().split(/\s+/)[2];
    if (!objectId) continue;
    materialEntries.push(`${filePath}\0${objectId}`);
  }
  materialEntries.sort();
  return createHash('sha256').update(materialEntries.join('\0')).digest('hex');
}

// ---------------------------------------------------------------------------
// CHK-001 fixture: tricky renames + a delete + a modify across two commits.
// ---------------------------------------------------------------------------

const RENAMES: Array<{ label: string; from: string; to: string }> = [
  { label: 'space', from: 'a b.txt', to: 'a c.txt' },
  { label: 'non-ASCII', from: '日本.txt', to: '日本語.txt' },
  { label: 'quote', from: 'q"uote.txt', to: 'q"uote2.txt' },
];
const DELETED = 'gone.txt';
const MODIFIED = 'plain.txt';

type TrickyRepo = { root: string; before: string; after: string };

function buildTrickyRepo(root: string): TrickyRepo {
  for (const rename of RENAMES) {
    writeFileSync(join(root, rename.from), `content of ${rename.label} is long enough to be tracked as a rename\n`, 'utf-8');
  }
  writeFileSync(join(root, DELETED), 'to be deleted\n', 'utf-8');
  writeFileSync(join(root, MODIFIED), 'first version\n', 'utf-8');
  git(root, ['add', '-A']);
  git(root, ['commit', '-q', '-m', 'before']);
  const before = git(root, ['rev-parse', 'HEAD']).trim();
  for (const rename of RENAMES) {
    git(root, ['mv', rename.from, rename.to]);
  }
  git(root, ['rm', '-q', DELETED]);
  writeFileSync(join(root, MODIFIED), 'second version\n', 'utf-8');
  git(root, ['add', '-A']);
  git(root, ['commit', '-q', '-m', 'after']);
  const after = git(root, ['rev-parse', 'HEAD']).trim();
  return { root, before, after };
}

function withTrickyRepo<T>(fn: (repo: TrickyRepo) => T): T {
  return withTempDir('tricky', root => fn(buildTrickyRepo(root)));
}

function assertBothSides(label: string, reported: string[], from: string, to: string): void {
  const missing = [from, to].filter(path => !reported.includes(path));
  assert.equal(
    missing.length,
    0,
    `${label}: expected both sides of the rename ${JSON.stringify(from)} -> ${JSON.stringify(to)}; missing ${JSON.stringify(missing)}; reported path set ${JSON.stringify(reported)}`,
  );
}

function renameCase(rename: { label: string; from: string; to: string }): SmokeCase {
  return {
    name: `rename of a path with a ${rename.label} reports both sides through both reader functions`,
    run: () => withTrickyRepo(({ root, before, after }) => {
      const files = changedFilesBetweenRenameAware(root, before, after);
      assertBothSides('changedFilesBetweenRenameAware', files, rename.from, rename.to);
      const statuses = changedFileStatusesBetweenRenameAware(root, before, after);
      assertBothSides('changedFileStatusesBetweenRenameAware', Object.keys(statuses), rename.from, rename.to);
      assert.ok(statuses[rename.from].startsWith('R'), `old side status must be R*, got ${statuses[rename.from]}`);
      assert.ok(statuses[rename.to].startsWith('R'), `new side status must be R*, got ${statuses[rename.to]}`);
    }),
  };
}

function walkTsFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === 'node_modules' || entry === 'dist') continue;
      walkTsFiles(full, out);
    } else if (entry.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out;
}

const READER_NAMES = ['changedFilesBetweenRenameAware', 'changedFileStatusesBetweenRenameAware', 'changedStoryFilesBetween'];

function functionBody(source: string, name: string): string {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `function ${name} not found in evidence-freshness.ts`);
  // The body brace is the first `{` that ends its line; a return type such as
  // `Array<{ path: string; deleted: boolean }>` also contains `{` and must be skipped.
  const open = source.indexOf('{\n', start);
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(open, i + 1);
    }
  }
  throw new Error(`unbalanced braces after function ${name}`);
}

group('CHK-001 rename-aware diff reader parses NUL-delimited output and fails loudly', [
  ...RENAMES.map(renameCase),
  {
    name: 'changedStoryFilesBetween reports both sides of every tricky rename (old side deleted, new side live)',
    run: () => withTrickyRepo(({ root, before, after }) => {
      const changedStoryFilesBetween = requireExport<ChangedStoryFilesBetween>('changedStoryFilesBetween');
      const entries = changedStoryFilesBetween(root, before, after);
      const byPath = new Map(entries.map(entry => [entry.path, entry.deleted]));
      for (const rename of RENAMES) {
        assertBothSides(`changedStoryFilesBetween (${rename.label})`, [...byPath.keys()], rename.from, rename.to);
        assert.equal(byPath.get(rename.from), true, `${rename.label}: old side must be marked deleted`);
        assert.equal(byPath.get(rename.to), false, `${rename.label}: new side must be live`);
      }
    }),
  },
  {
    name: 'a deleted path is still reported by all three readers',
    run: () => withTrickyRepo(({ root, before, after }) => {
      assert.ok(changedFilesBetweenRenameAware(root, before, after).includes(DELETED), 'changedFilesBetweenRenameAware dropped the deleted path');
      assert.equal(changedFileStatusesBetweenRenameAware(root, before, after)[DELETED], 'D');
      const entries = requireExport<ChangedStoryFilesBetween>('changedStoryFilesBetween')(root, before, after);
      assert.deepEqual(entries.find(entry => entry.path === DELETED), { path: DELETED, deleted: true });
      assert.equal(changedFileStatusesBetweenRenameAware(root, before, after)[MODIFIED], 'M');
    }),
  },
  {
    name: 'a copy record (C100) reports both sides through all three readers',
    run: () => withTrickyRepo(({ root, before, after }) => {
      // `-M` alone never emits C records from real git (explicit -M overrides
      // diff.renames=copies), so the record is injected on the git output path.
      withStubbedGitDiff([['C100', 'src.txt', 'copy.txt']], () => {
        assert.deepEqual(changedFilesBetweenRenameAware(root, before, after), ['copy.txt', 'src.txt']);
        assert.deepEqual(changedFileStatusesBetweenRenameAware(root, before, after), { 'copy.txt': 'C100', 'src.txt': 'C100' });
        const entries = requireExport<ChangedStoryFilesBetween>('changedStoryFilesBetween')(root, before, after);
        assert.deepEqual(entries, [{ path: 'copy.txt', deleted: false }, { path: 'src.txt', deleted: true }]);
      });
    }),
  },
  {
    name: 'plain-path repository: new reader equals the local tab-parser reference for all three readers',
    run: () => withTrickyRepo(({ root, before, after }) => {
      // Only plain paths in this slice: the reference tab parser is exact there.
      // Compare on a sub-range that excludes the tricky names by building a
      // second, plain-only repository.
      void root; void before; void after;
      withTempDir('plain', plainRoot => {
        writeFileSync(join(plainRoot, 'keep.txt'), 'keep\n', 'utf-8');
        writeFileSync(join(plainRoot, 'old.txt'), 'rename me, content long enough to track\n', 'utf-8');
        writeFileSync(join(plainRoot, 'drop.txt'), 'drop\n', 'utf-8');
        git(plainRoot, ['add', '-A']);
        git(plainRoot, ['commit', '-q', '-m', 'one']);
        const one = git(plainRoot, ['rev-parse', 'HEAD']).trim();
        git(plainRoot, ['mv', 'old.txt', 'new.txt']);
        git(plainRoot, ['rm', '-q', 'drop.txt']);
        writeFileSync(join(plainRoot, 'keep.txt'), 'keep changed\n', 'utf-8');
        writeFileSync(join(plainRoot, 'added.txt'), 'added\n', 'utf-8');
        git(plainRoot, ['add', '-A']);
        git(plainRoot, ['commit', '-q', '-m', 'two']);
        const two = git(plainRoot, ['rev-parse', 'HEAD']).trim();
        assert.deepEqual(changedFilesBetweenRenameAware(plainRoot, one, two), referenceChangedFilesBetweenRenameAware(plainRoot, one, two));
        assert.deepEqual(changedFileStatusesBetweenRenameAware(plainRoot, one, two), referenceChangedFileStatusesBetweenRenameAware(plainRoot, one, two));
        const changedStoryFilesBetween = requireExport<ChangedStoryFilesBetween>('changedStoryFilesBetween');
        assert.deepEqual(changedStoryFilesBetween(plainRoot, one, two), referenceChangedStoryFilesBetween(plainRoot, one, two));
      });
    }),
  },
  {
    name: 'plain-path repository: materialHash and storyFilesHash are byte-identical to the reference formulas',
    run: () => withTempDir('hash', root => {
      writeFileSync(join(root, 'proof-or-stop.config.json'), JSON.stringify({
        scanRoot: 'packages/main',
        rootDir: 'src',
        storyDir: '.proof-or-stop/story/actives',
        requirementsDir: 'docs/requirements',
      }, null, 2), 'utf-8');
      resetConfigCache();
      writeFileSync(join(root, 'README.md'), '# hash parity fixture\n', 'utf-8');
      writeFileSync(join(root, 'src.ts'), 'export const a = 1;\n', 'utf-8');
      writeFileSync(join(root, 'old.ts'), 'export const renamed = "long enough to be tracked as a rename";\n', 'utf-8');
      git(root, ['add', '-A']);
      git(root, ['commit', '-q', '-m', 'base']);
      git(root, ['checkout', '-q', '-b', 'story/B-41c8']);
      git(root, ['mv', 'old.ts', 'new.ts']);
      git(root, ['rm', '-q', 'README.md']);
      writeFileSync(join(root, 'src.ts'), 'export const a = 2;\n', 'utf-8');
      writeFileSync(join(root, 'extra.ts'), 'export const extra = true;\n', 'utf-8');
      git(root, ['add', '-A']);
      git(root, ['commit', '-q', '-m', 'story change']);
      const materialHash = currentMaterialHash(root, 'HEAD', root);
      const storyFilesHash = currentStoryFilesHash(root, 'HEAD', root);
      assert.ok(materialHash, 'currentMaterialHash returned undefined');
      assert.ok(storyFilesHash, 'currentStoryFilesHash returned undefined');
      assert.equal(materialHash, referenceMaterialHash(root, 'HEAD', root), 'materialHash differs from the reference');
      assert.equal(storyFilesHash, referenceStoryFilesHash(root, 'HEAD', root), 'storyFilesHash differs from the reference');
      assert.notEqual(storyFilesHash, freshnessModule.EMPTY_STORY_FILES_HASH, 'fixture must produce a non-empty story diff');
    }),
  },
  {
    name: 'an unresolvable ref still throws from all three readers (contract unchanged)',
    run: () => withTrickyRepo(({ root, after }) => {
      const changedStoryFilesBetween = requireExport<ChangedStoryFilesBetween>('changedStoryFilesBetween');
      assert.throws(() => changedFilesBetweenRenameAware(root, 'no-such-ref', after), /unknown revision|bad revision|ambiguous argument/);
      assert.throws(() => changedFileStatusesBetweenRenameAware(root, 'no-such-ref', after), /unknown revision|bad revision|ambiguous argument/);
      assert.throws(() => changedStoryFilesBetween(root, 'no-such-ref', after), /unknown revision|bad revision|ambiguous argument/);
    }),
  },
  {
    name: 'a malformed record makes every reader throw an Error naming the raw record instead of skipping it',
    run: () => withTrickyRepo(({ root, before, after }) => {
      const changedStoryFilesBetween = requireExport<ChangedStoryFilesBetween>('changedStoryFilesBetween');
      const malformedShapes: Array<{ label: string; records: string[][]; marker: string }> = [
        { label: 'unknown status token', records: [['M', 'fine.txt'], ['Q', 'weird.txt']], marker: 'weird.txt' },
        { label: 'rename missing its second path', records: [['R100', 'only-one.txt']], marker: 'only-one.txt' },
        { label: 'empty path', records: [['A', '']], marker: 'A' },
      ];
      for (const shape of malformedShapes) {
        withStubbedGitDiff(shape.records, () => {
          for (const [name, reader] of [
            ['changedFilesBetweenRenameAware', () => changedFilesBetweenRenameAware(root, before, after)],
            ['changedFileStatusesBetweenRenameAware', () => changedFileStatusesBetweenRenameAware(root, before, after)],
            ['changedStoryFilesBetween', () => changedStoryFilesBetween(root, before, after)],
          ] as Array<[string, () => unknown]>) {
            let thrown: unknown;
            let result: unknown;
            try {
              result = reader();
            } catch (error) {
              thrown = error;
            }
            assert.ok(thrown instanceof Error, `${name} (${shape.label}): expected an Error, got result ${JSON.stringify(result)}`);
            assert.ok(thrown.message.includes(shape.marker), `${name} (${shape.label}): message must contain the raw record; got: ${thrown.message}`);
          }
        });
      }
    }),
  },
  {
    name: 'exported parseNameStatusRecords rejects a malformed record and never drops a well-formed one',
    run: () => {
      const parse = requireExport<ParseNameStatusRecords>('parseNameStatusRecords');
      assert.deepEqual(parse(''), []);
      assert.deepEqual(parse('M\0a b.txt\0R100\0q"uote.txt\0q"uote2.txt\0D\0gone\0'), [
        { status: 'M', path: 'a b.txt' },
        { status: 'R100', oldPath: 'q"uote.txt', path: 'q"uote2.txt' },
        { status: 'D', path: 'gone' },
      ]);
      assert.throws(() => parse('M\0ok.txt\0Q\0weird.txt\0'), /weird\.txt/);
      assert.throws(() => parse('R100\0only-one.txt\0'), /only-one\.txt/);
      assert.throws(() => parse('M\0dangling'), /dangling/);
    },
  },
  {
    name: 'no reader body catches, and no caller wraps these readers in catch { return [] }',
    run: () => {
      const readerSource = readFileSync(join(MAIN_SRC, 'core', 'evidence-freshness.ts'), 'utf-8');
      // The readers may share ONE git invocation helper; follow that single
      // level of delegation and hold the helper to the same rules.
      const invokesNulDiff = (body: string): boolean => {
        if (body.includes("'-z'")) return body.includes("'--name-status'") && body.includes("'-M'");
        const delegate = body.match(/\b(\w+)\(gitCwd, fromHead, toHead\)/);
        if (!delegate) return false;
        const delegateBody = functionBody(readerSource, delegate[1]);
        assert.ok(!/\bcatch\b/.test(delegateBody), `${delegate[1]} must not catch (it would hide a git failure as a shorter list)`);
        return delegateBody.includes("'-z'") && delegateBody.includes("'--name-status'") && delegateBody.includes("'-M'");
      };
      for (const name of READER_NAMES) {
        const body = functionBody(readerSource, name);
        assert.ok(!/\bcatch\b/.test(body), `${name} must not catch (it would hide a git failure as a shorter list)`);
        assert.ok(invokesNulDiff(body), `${name} must invoke git diff --name-status -M -z (directly or through one shared helper)`);
      }
      const offenders: string[] = [];
      const tryCatchEmpty = /try\s*\{([\s\S]*?)\}\s*catch\s*(?:\([^)]*\))?\s*\{\s*return\s*\[\]\s*;?\s*\}/g;
      for (const file of walkTsFiles(MAIN_SRC)) {
        if (resolve(file) === resolve(fileURLToPath(import.meta.url).replace(/dist[\\/]tasks/, 'src/tasks'))) continue;
        const source = readFileSync(file, 'utf-8');
        if (!READER_NAMES.some(name => source.includes(name))) continue;
        for (const match of source.matchAll(tryCatchEmpty)) {
          if (READER_NAMES.some(name => match[1].includes(name))) {
            offenders.push(`${file.slice(MAIN_SRC.length + 1)}: ${match[0].split('\n')[0]}`);
          }
        }
      }
      assert.deepEqual(offenders, [], `catch { return [] } around a reader: ${offenders.join('; ')}`);
    },
  },
]);

// ---------------------------------------------------------------------------
// CHK-002 — one owner for the legacy command-string parse.
//
// core/done-required-validation.ts carried a private copy of the shell
// metacharacter rule and the word splitter that core/validation-command-identity.ts
// owns as `parseLegacyValidationCommandString`. Two self-consistent copies of
// the same parse are a false-provenance risk between pin identity and
// DONE-required execution, so the corpus below pins the EXPECTED tuple for every
// tricky input and every call site must produce exactly that tuple.
//
// Comparison key is {shell, command, args} where `shell` is the DECLARED intent
// (`shell === true`), which is how every consumer in both files reads it.
// The argv branch of a call-site wrapper omits the `shell` key entirely (a
// shape choice preserved for byte-identical command-spec digests); the
// canonical parser spells it `shell: false`. That is a representation
// difference, not a parse difference, and `declaredShellTuple` makes it
// explicit instead of tolerating it silently.
// ---------------------------------------------------------------------------

type ParsedTuple = { shell: boolean; command: string; args: string[] };
type CorpusEntry = { label: string; input: string; expected: ParsedTuple | null };

/** The explicit comparison key: declared shell intent + argv, nothing else. */
function declaredShellTuple(value: { shell?: boolean; command: string; args: string[] } | null): ParsedTuple | null {
  if (value === null) return null;
  return { shell: value.shell === true, command: value.command, args: [...value.args] };
}

const COMMAND_CORPUS: CorpusEntry[] = [
  { label: 'plain two-word command', input: 'npm test', expected: { shell: false, command: 'npm', args: ['test'] } },
  { label: 'bare executable', input: 'node', expected: { shell: false, command: 'node', args: [] } },
  { label: 'leading and trailing whitespace', input: '  node packages/main/dist/cli.js validate  ', expected: { shell: false, command: 'node', args: ['packages/main/dist/cli.js', 'validate'] } },
  { label: 'tab and repeated spaces between words', input: 'node\tdist/x.js   --flag', expected: { shell: false, command: 'node', args: ['dist/x.js', '--flag'] } },
  { label: 'empty string', input: '', expected: null },
  { label: 'whitespace only', input: '   \t ', expected: null },
  { label: 'metacharacter &&', input: 'npm run build && npm test', expected: { shell: true, command: 'npm run build && npm test', args: [] } },
  { label: 'metacharacter | (pipe)', input: 'echo hi | grep h', expected: { shell: true, command: 'echo hi | grep h', args: [] } },
  { label: 'metacharacter $ (variable)', input: 'printf %s $HOME', expected: { shell: true, command: 'printf %s $HOME', args: [] } },
  { label: 'metacharacter < (redirect)', input: 'cat <file.txt', expected: { shell: true, command: 'cat <file.txt', args: [] } },
  { label: 'metacharacter backtick', input: 'echo `date`', expected: { shell: true, command: 'echo `date`', args: [] } },
  { label: 'metacharacter ( ) subshell with leading/trailing whitespace', input: ' (cd x && make) ', expected: { shell: true, command: '(cd x && make)', args: [] } },
  { label: 'metacharacter ; inside a double-quoted argument still selects shell', input: 'node -e "console.log(1); process.exit(0)"', expected: { shell: true, command: 'node -e "console.log(1); process.exit(0)"', args: [] } },
  { label: 'double-quoted argument with an embedded space', input: 'git commit -m "two words"', expected: { shell: false, command: 'git', args: ['commit', '-m', 'two words'] } },
  { label: 'single-quoted argument with embedded spaces', input: "git commit -m 'single quoted arg'", expected: { shell: false, command: 'git', args: ['commit', '-m', 'single quoted arg'] } },
  { label: 'single-quoted argument containing double quotes and a space', input: 'sh -c \'echo "a b"\'', expected: { shell: false, command: 'sh', args: ['-c', 'echo "a b"'] } },
  { label: 'escaped double quote outside quotes', input: 'echo it\\"s', expected: { shell: false, command: 'echo', args: ['it"s'] } },
  { label: 'escaped double quote inside a double-quoted argument', input: 'echo "escaped \\" inside"', expected: { shell: false, command: 'echo', args: ['escaped " inside'] } },
  { label: 'double-quoted executable with an embedded space', input: '"quoted command" arg', expected: { shell: false, command: 'quoted command', args: ['arg'] } },
  { label: 'bare double-quoted executable', input: '"a b"', expected: { shell: false, command: 'a b', args: [] } },
  { label: 'empty quoted argument is dropped (shared quirk, pinned so it cannot drift silently)', input: "echo ''", expected: { shell: false, command: 'echo', args: [] } },
  { label: 'unterminated single quote keeps the rest as one argument', input: "echo 'unterminated", expected: { shell: false, command: 'echo', args: ['unterminated'] } },
  { label: 'trailing backslash is consumed', input: 'echo trailing\\', expected: { shell: false, command: 'echo', args: ['trailing'] } },
  { label: 'backslash-escaped space joins words', input: 'ls my\\ dir', expected: { shell: false, command: 'ls', args: ['my dir'] } },
];

type CorpusCallSites = {
  doneRequired: ReturnType<typeof resolveDoneRequiredPolicy>;
  verifier: ReturnType<typeof configuredValidationCommands>;
};

/**
 * Writes the whole corpus as string entries into BOTH `doneRequiredCommands`
 * and `validate.commands` of a real config file, then reads it back through
 * the two production entry points. Index i of the corpus is labelled
 * `doneRequiredCommands[i]` / `configured validate.commands[i]` by the call
 * sites themselves, which is what the cases key on.
 */
function withCorpusConfig<T>(fn: (sites: CorpusCallSites) => T): T {
  return withTempDir('corpus', root => {
    writeFileSync(join(root, 'proof-or-stop.config.json'), JSON.stringify({
      scanRoot: 'packages/main',
      rootDir: 'src',
      storyDir: '.proof-or-stop/story/actives',
      requirementsDir: 'docs/requirements',
      doneRequiredCommands: COMMAND_CORPUS.map(entry => entry.input),
      validate: { commands: COMMAND_CORPUS.map(entry => entry.input) },
    }, null, 2), 'utf-8');
    resetConfigCache();
    try {
      return fn({ doneRequired: resolveDoneRequiredPolicy(root), verifier: configuredValidationCommands(root) });
    } finally {
      resetConfigCache();
    }
  });
}

function assertCorpusTuple(site: string, entry: CorpusEntry, actual: ParsedTuple | null): void {
  assert.deepEqual(
    actual,
    entry.expected,
    `${site} disagrees on ${entry.label} ${JSON.stringify(entry.input)}: got ${JSON.stringify(actual)}, expected ${JSON.stringify(entry.expected)}`,
  );
}

const PRIVATE_PARSER_TOKENS = ['splitShellWords', 'SHELL_META_RE', 'commandFromString'];

group('CHK-002 done-required command parse is owned by parseLegacyValidationCommandString', [
  {
    name: 'corpus: the canonical parser produces the pinned {shell, command, args} for every entry',
    run: () => {
      for (const entry of COMMAND_CORPUS) {
        assertCorpusTuple('parseLegacyValidationCommandString', entry, declaredShellTuple(parseLegacyValidationCommandString(entry.input)));
      }
    },
  },
  {
    name: 'corpus: the DONE-required executor path and handlers/verifier.ts produce the same {shell, command, args} for every entry',
    run: () => withCorpusConfig(({ doneRequired, verifier }) => {
      for (const [index, entry] of COMMAND_CORPUS.entries()) {
        const fromDoneRequired = doneRequired.commands.find(command => command.label === `doneRequiredCommands[${index}]`) ?? null;
        const fromVerifier = verifier.find(command => command.label === `configured validate.commands[${index}]`) ?? null;
        assertCorpusTuple('resolveDoneRequiredPolicy (DONE-required executor path)', entry, declaredShellTuple(fromDoneRequired));
        assertCorpusTuple('configuredValidationCommands (handlers/verifier.ts)', entry, declaredShellTuple(fromVerifier));
        assertCorpusTuple('parseLegacyValidationCommandString', entry, declaredShellTuple(parseLegacyValidationCommandString(entry.input)));
      }
      // The two null entries are rejected loudly by the DONE-required policy
      // and dropped by the verifier; neither becomes a command.
      const nullIndexes = COMMAND_CORPUS.map((entry, index) => (entry.expected === null ? index : -1)).filter(index => index >= 0);
      assert.ok(nullIndexes.length >= 2, 'corpus must keep at least two entries that name no command');
      for (const index of nullIndexes) {
        assert.ok(
          doneRequired.configErrors.includes(`doneRequiredCommands[${index}] must not be empty`),
          `DONE-required policy must reject doneRequiredCommands[${index}]; configErrors=${JSON.stringify(doneRequired.configErrors)}`,
        );
      }
      assert.equal(doneRequired.commands.length, COMMAND_CORPUS.length - nullIndexes.length);
      assert.equal(verifier.length, COMMAND_CORPUS.length - nullIndexes.length);
    }),
  },
  {
    name: 'shape: the argv branch omits the shell key at both call sites, the shell branch sets shell=true (pre-CHK-002 shape preserved)',
    run: () => withCorpusConfig(({ doneRequired, verifier }) => {
      for (const [index, entry] of COMMAND_CORPUS.entries()) {
        if (entry.expected === null) continue;
        const fromDoneRequired = doneRequired.commands.find(command => command.label === `doneRequiredCommands[${index}]`);
        const fromVerifier = verifier.find(command => command.label === `configured validate.commands[${index}]`);
        assert.ok(fromDoneRequired && fromVerifier, `entry ${index} missing at a call site`);
        for (const [site, command] of [['DONE-required', fromDoneRequired], ['verifier', fromVerifier]] as const) {
          if (entry.expected.shell) {
            assert.equal(command.shell, true, `${site}: ${entry.label} must carry shell: true`);
            assert.deepEqual(command.args, [], `${site}: ${entry.label} shell branch must carry no args`);
          } else {
            assert.ok(!('shell' in command), `${site}: ${entry.label} argv branch must omit the shell key; got ${JSON.stringify(command)}`);
          }
        }
      }
    }),
  },
  {
    name: 'structural: done-required-validation.ts defines no private parser and imports the canonical one',
    run: () => {
      const source = readFileSync(join(MAIN_SRC, 'core', 'done-required-validation.ts'), 'utf-8');
      const hits = PRIVATE_PARSER_TOKENS.filter(token => source.includes(token));
      assert.deepEqual(hits, [], `private parser tokens still present in done-required-validation.ts: ${hits.join(', ')}`);
      assert.match(
        source,
        /import\s*\{[^}]*\bparseLegacyValidationCommandString\b[^}]*\}\s*from\s*'\.\/validation-command-identity\.js'/,
        'done-required-validation.ts must import parseLegacyValidationCommandString from ./validation-command-identity.js',
      );
      assert.ok(source.includes('parseLegacyValidationCommandString('), 'done-required-validation.ts must call parseLegacyValidationCommandString');
    },
  },
]);

// ---------------------------------------------------------------------------
// CHK-003 — one owner for story workspace resolution.
//
// Four implementations used to decide, each on its own, which tree a story's
// git work / StoryStore / config live in: story-query.ts `readStoryProjection`
// (+ `listLinkedStoryWorktrees`), session.ts `listActiveWorktrees` +
// `readStoryFromLinkedWorktree`, local-assurance-story-projection.ts
// `collectLinkedStoryWorktrees` (+ `readWorktreePhase`) and validation-plan.ts
// `resolveStoryWorkspace` (B-a745 F-010). The first two applied the
// phase-terminal guard (`phase !== 'DONE' && phase !== 'DISCARDED'`) before
// reading a linked worktree; the last two did not, and none of the listing
// variants honoured a configured wrapper-root `gitRoot` (the `git worktree
// list` they ran in the non-git metadata root returned nothing).
//
// The RED cases below fail against that state: `core/story-workspace.ts` does
// not exist, the structural case finds the four private implementations still
// in place, and the wrapper-root fixture shows the local assurance projection
// not finding the story worktree. GREEN adds the helper
// (`resolveStoryWorkspace`) and migrates the four call sites onto it.
//
// Fixture shape (modelled on B-a745's F-010 cases): a metadata root holding
// proof-or-stop.config.json and the story record (phase DEV, NO worktree
// binding so the resolver has to find the linked story branch itself), a git
// root (the metadata root on the plain layout, `repo/` below it with
// `gitRoot: "repo"` on the wrapper layout) with one base commit, and a linked
// worktree on `story/<id>` whose own commit advances the story (phase TEST, a
// worktree-only validate.commands entry pinned by a worktree-only checklist
// item) — so a read that lands in the wrong tree is visible as the wrong
// phase, the wrong checklist and a different selectionDigest.
// ---------------------------------------------------------------------------

const WS_STORY_ID = 'B-c003';
const WS_CHANGED_FILE = 'src/core/workspace-touched.ts';
const WS_WORKTREE_COMMAND_ID = 'workspace-suite';
const WS_STORY_BRANCH = `story/${WS_STORY_ID}`;
const WS_FIXTURE_ROOTS: string[] = [];

interface WorkspaceFixture {
  metadataRoot: string;
  gitRoot: string;
  worktreePath: string;
}

function canonical(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

function writeFixtureFile(root: string, relPath: string, content: string): void {
  const absolute = join(root, relPath);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, content, 'utf-8');
}

function workspaceConfigJson(layout: 'plain' | 'wrapper-root', extraCommands: unknown[]): string {
  return `${JSON.stringify({
    storyDir: '.proof-or-stop/story/actives',
    ...(layout === 'wrapper-root' ? { gitRoot: 'repo' } : {}),
    validate: {
      commands: [
        { label: 'unit', command: 'npm', args: ['test'], id: 'unit-suite' },
        ...extraCommands,
      ],
    },
  }, null, 2)}\n`;
}

function workspaceStory(phase: StoryInfo['phase']): StoryInfo {
  return {
    storyId: WS_STORY_ID,
    name: 'story-workspace-fixture',
    title: 'One owner for story workspace resolution',
    description: 'Fixture story whose work lives in a linked worktree.',
    type: 'feature',
    phase,
    priority: 'high',
    createdAt: '2026-01-01T00:00:00.000Z',
    startedAt: null,
    endedAt: null,
  };
}

function buildWorkspaceFixture(layout: 'plain' | 'wrapper-root'): WorkspaceFixture {
  const metadataRoot = mkdtempSync(join(tmpdir(), `${MARKER}-workspace-${layout}-`));
  WS_FIXTURE_ROOTS.push(metadataRoot);
  const gitRoot = layout === 'wrapper-root' ? join(metadataRoot, 'repo') : metadataRoot;
  mkdirSync(gitRoot, { recursive: true });

  writeFixtureFile(metadataRoot, 'proof-or-stop.config.json', workspaceConfigJson(layout, []));
  writeFixtureFile(gitRoot, '.gitignore', '.worktrees/\n');
  writeFixtureFile(gitRoot, 'README.md', '# story workspace fixture\n');
  writeFixtureFile(gitRoot, WS_CHANGED_FILE, 'export const touched = 0;\n');
  git(gitRoot, ['init', '-q']);
  git(gitRoot, ['checkout', '-q', '-B', 'main']);
  git(gitRoot, ['add', '-A']);
  git(gitRoot, ['commit', '-q', '-m', 'base']);

  resetConfigCache();
  const store = new StoryStore(metadataRoot);
  store.writeStory(WS_STORY_ID, workspaceStory('DEV'));
  store.writeChecklist(WS_STORY_ID, { items: [] });
  if (layout === 'plain') {
    git(gitRoot, ['add', '-A']);
    git(gitRoot, ['commit', '-q', '-m', 'story metadata']);
  }

  const worktreePath = join(gitRoot, '.worktrees', WS_STORY_ID);
  git(gitRoot, ['branch', WS_STORY_BRANCH]);
  git(gitRoot, ['worktree', 'add', '-q', worktreePath, WS_STORY_BRANCH]);
  writeFixtureFile(worktreePath, WS_CHANGED_FILE, 'export const touched = 1;\n');
  if (layout === 'plain') {
    // The story's metadata and command inventory evolve on the story branch:
    // main's committed copies are the stale INIT snapshot.
    writeFixtureFile(
      worktreePath,
      'proof-or-stop.config.json',
      workspaceConfigJson(layout, [{ label: 'workspace', command: 'npm', args: ['run', 'workspace'], id: WS_WORKTREE_COMMAND_ID }]),
    );
    resetConfigCache();
    const worktreeStore = new StoryStore(worktreePath);
    worktreeStore.writeStory(WS_STORY_ID, workspaceStory('TEST'));
    worktreeStore.writeChecklist(WS_STORY_ID, {
      items: [
        {
          id: 'CHK-001',
          title: 'Touch the workspace file',
          context: 'worktree-only item',
          status: 'done',
          files: { modify: [WS_CHANGED_FILE], create: [], test: [] },
          verificationEvidence: [
            { intentRef: 'CHK-001:happy:0', kind: 'integration_test', command: 'npm run workspace', result: 'pass', note: 'worktree-only pin' },
          ],
        } as unknown as ChecklistData['items'][number],
      ],
    });
  }
  git(worktreePath, ['add', '-A']);
  git(worktreePath, ['commit', '-q', '-m', 'story change']);
  resetConfigCache();
  return { metadataRoot, gitRoot, worktreePath };
}

/** The story is DONE on main and its worktree was merged and removed (the normal end of a story). */
function markDoneAndRemoveWorktree(fixture: WorkspaceFixture): void {
  resetConfigCache();
  new StoryStore(fixture.metadataRoot).writeStory(WS_STORY_ID, workspaceStory('DONE'));
  git(fixture.gitRoot, ['worktree', 'remove', '--force', fixture.worktreePath]);
  git(fixture.gitRoot, ['branch', '-D', WS_STORY_BRANCH]);
  resetConfigCache();
}

/** The story is DONE on main but a residual worktree still exists (terminal-worktree residue). */
function markDoneKeepResidue(fixture: WorkspaceFixture): void {
  resetConfigCache();
  new StoryStore(fixture.metadataRoot).writeStory(WS_STORY_ID, workspaceStory('DONE'));
  resetConfigCache();
}

function ctxAt(root: string): HandlerContext {
  resetConfigCache();
  return { store: new StoryStore(root), root, scanRoot: root } as HandlerContext;
}

function cleanupWorkspaceFixtures(): void {
  for (const root of WS_FIXTURE_ROOTS.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
}

type StoryWorkspaceResult = {
  gitCwd: string;
  store: StoryStore;
  config: { validate?: { commands?: Array<{ id?: string }> } };
  source: 'linked-worktree' | 'invocation-root';
  rootReason: string | null;
  worktreePath: string | null;
  story: StoryInfo;
  rootStory: StoryInfo;
};
type ResolveStoryWorkspaceFn = (
  ctx: { store: StoryStore; root: string },
  storyId: string,
  options?: { terminalPhaseGuard?: boolean },
) => StoryWorkspaceResult;

/**
 * The RED commit compiles against a tree that has no `core/story-workspace.ts`
 * yet; resolving the module through a computed specifier keeps the smoke
 * compiling while every case that needs the helper fails loudly.
 */
const WS_MODULE_SPECIFIER = '../core/story-workspace.js';
const workspaceModule = await import(WS_MODULE_SPECIFIER).catch(() => null) as Record<string, unknown> | null;

function resolveWorkspaceFn(): ResolveStoryWorkspaceFn {
  const fn = workspaceModule?.resolveStoryWorkspace;
  if (typeof fn !== 'function') {
    throw new Error('core/story-workspace.ts does not export resolveStoryWorkspace');
  }
  return fn as ResolveStoryWorkspaceFn;
}

function planFromRoot(root: string): Record<string, any> {
  const ctx = ctxAt(root);
  return JSON.parse(createValidationPlanHandlers(ctx).validation_plan({ storyId: WS_STORY_ID, tier: 'fast', json: true })) as Record<string, any>;
}

function planUnitIds(report: Record<string, any>): string[] {
  return (report.units as Array<{ id: string }>).map((unit) => unit.id).sort();
}

function storyListRow(root: string): Record<string, unknown> {
  const listed = createStoryQueryHandlers(ctxAt(root)).story_list({ full: true }) as { stories: Array<Record<string, unknown>> };
  const row = listed.stories.find((entry) => entry.storyId === WS_STORY_ID);
  assert.ok(row, `story_list from ${root} must list ${WS_STORY_ID}`);
  return row!;
}

function briefFromRoot(root: string): string {
  return createSessionHandlers(ctxAt(root)).session_brief({});
}

function assuranceRow(root: string, activeOnly: boolean) {
  resetConfigCache();
  const projection = resolveLocalAssuranceStories(new StoryStore(root), root, { activeOnly, now: '2026-01-01T00:00:00.000Z' });
  const row = projection.stories.find((entry) => entry.storyId === WS_STORY_ID);
  assert.ok(row, `local assurance projection from ${root} must include ${WS_STORY_ID}`);
  return row!;
}

const WS_HELPER_IMPORT_RE = /import\s*\{[^}]*\bresolveStoryWorkspace\b[^}]*\}\s*from\s*'(\.\.\/core|\.)\/story-workspace\.js'/;

const WS_MIGRATED_SITES: Array<{ file: string; removed: string[] }> = [
  {
    file: 'handlers/story-query.ts',
    removed: ['function listLinkedStoryWorktrees', 'new StoryStore(linkedPath)', "mainStory.phase !== 'DONE' &&"],
  },
  {
    file: 'handlers/session.ts',
    removed: ['function listActiveWorktrees', 'function readStoryFromLinkedWorktree', 'git worktree list --porcelain', 'new StoryStore(worktreePath)', 'new StoryStore(wt)'],
  },
  {
    file: 'core/local-assurance-story-projection.ts',
    removed: ['function collectLinkedStoryWorktrees', 'function readWorktreePhase', 'new StoryStore(', 'listGitWorktrees'],
  },
  {
    file: 'handlers/validation-plan.ts',
    removed: ['function resolveStoryWorkspace', 'new StoryStore(', 'loadConfig(', 'resolveGitCwd('],
  },
];

group('CHK-003 story workspace resolution is owned by core/story-workspace.ts', [
  {
    name: 'helper: from the main checkout an active story resolves to its linked worktree (gitCwd from resolveGitCwd, store and config rooted there, source=linked-worktree)',
    run: () => {
      const fixture = buildWorkspaceFixture('plain');
      const ctx = ctxAt(fixture.metadataRoot);
      const workspace = resolveWorkspaceFn()(ctx, WS_STORY_ID);
      const expectedGitCwd = resolveGitCwd({
        store: ctx.store,
        storyId: WS_STORY_ID,
        metadataRoot: ctx.root,
        projectRoot: ctx.root,
        config: loadConfig(ctx.root),
      });
      assert.equal(workspace.gitCwd, expectedGitCwd, 'gitCwd must be exactly what resolveGitCwd returns');
      assert.equal(canonical(workspace.gitCwd), canonical(fixture.worktreePath));
      assert.equal(workspace.source, 'linked-worktree');
      assert.equal(workspace.rootReason, null);
      assert.equal(canonical(workspace.worktreePath ?? ''), canonical(fixture.worktreePath));
      assert.equal(canonical(workspace.store.projectRoot), canonical(fixture.worktreePath), 'the store must be rooted at the linked worktree');
      assert.equal(workspace.story.phase, 'TEST', 'the story must be read from the worktree copy');
      assert.equal(workspace.rootStory.phase, 'DEV', 'rootStory must be the invocation root copy');
      assert.ok(
        (workspace.config.validate?.commands ?? []).some((command) => command.id === WS_WORKTREE_COMMAND_ID),
        'config must be loaded from the linked worktree (it carries the worktree-only validate.commands entry)',
      );
    },
  },
  {
    name: 'helper: from inside the story worktree the same story resolves to the same gitCwd with source=invocation-root (same tree)',
    run: () => {
      const fixture = buildWorkspaceFixture('plain');
      const ctx = ctxAt(fixture.worktreePath);
      const workspace = resolveWorkspaceFn()(ctx, WS_STORY_ID);
      assert.equal(canonical(workspace.gitCwd), canonical(fixture.worktreePath));
      assert.equal(workspace.source, 'invocation-root');
      assert.equal(workspace.rootReason, 'same-tree');
      assert.equal(workspace.store, ctx.store, 'same tree: the invocation store is the workspace store');
      assert.equal(workspace.story.phase, 'TEST');
      assert.equal(canonical(workspace.worktreePath ?? ''), canonical(fixture.worktreePath), 'the story worktree is still reported when we are inside it');
    },
  },
  {
    name: 'guard: a DONE story whose worktree was merged and removed never resolves a linked worktree, with the guard on or off',
    run: () => {
      const fixture = buildWorkspaceFixture('plain');
      markDoneAndRemoveWorktree(fixture);
      const ctx = ctxAt(fixture.metadataRoot);
      for (const terminalPhaseGuard of [true, false]) {
        const workspace = resolveWorkspaceFn()(ctx, WS_STORY_ID, { terminalPhaseGuard });
        assert.equal(workspace.source, 'invocation-root', `terminalPhaseGuard=${terminalPhaseGuard}`);
        assert.equal(canonical(workspace.gitCwd), canonical(fixture.metadataRoot), `terminalPhaseGuard=${terminalPhaseGuard}: gitCwd must be the invocation root`);
        assert.equal(workspace.store, ctx.store, `terminalPhaseGuard=${terminalPhaseGuard}: store must be the invocation store`);
        assert.equal(workspace.worktreePath, null, `terminalPhaseGuard=${terminalPhaseGuard}: no worktree may be reported`);
        assert.equal(workspace.story.phase, 'DONE');
      }
    },
  },
  {
    name: 'guard: a DONE story with a residual worktree is refused under the guard (rootReason=terminal-phase) and read from the residue only when the option is off',
    run: () => {
      const fixture = buildWorkspaceFixture('plain');
      markDoneKeepResidue(fixture);
      const ctx = ctxAt(fixture.metadataRoot);
      const guarded = resolveWorkspaceFn()(ctx, WS_STORY_ID, { terminalPhaseGuard: true });
      assert.equal(guarded.source, 'invocation-root');
      assert.equal(guarded.rootReason, 'terminal-phase');
      assert.equal(guarded.store, ctx.store);
      assert.equal(guarded.story.phase, 'DONE');
      assert.equal(guarded.worktreePath, null);
      const byDefault = resolveWorkspaceFn()(ctx, WS_STORY_ID);
      assert.equal(byDefault.rootReason, 'terminal-phase', 'the helper default must be the guarded behaviour');
      const unguarded = resolveWorkspaceFn()(ctx, WS_STORY_ID, { terminalPhaseGuard: false });
      assert.equal(unguarded.source, 'linked-worktree');
      assert.equal(unguarded.story.phase, 'TEST');
      assert.equal(canonical(unguarded.worktreePath ?? ''), canonical(fixture.worktreePath));
    },
  },
  {
    name: 'wrapper-root: gitRoot configured below the invocation root resolves the story worktree through the helper',
    run: () => {
      const fixture = buildWorkspaceFixture('wrapper-root');
      const ctx = ctxAt(fixture.metadataRoot);
      const workspace = resolveWorkspaceFn()(ctx, WS_STORY_ID);
      assert.equal(canonical(workspace.gitCwd), canonical(fixture.worktreePath), 'gitCwd must be the linked worktree under the configured gitRoot');
      assert.equal(canonical(workspace.worktreePath ?? ''), canonical(fixture.worktreePath));
      // The wrapper layout keeps the metadata outside git, so the worktree has no
      // copy of the story: the store and config stay on the invocation root.
      assert.equal(workspace.source, 'invocation-root');
      assert.equal(workspace.rootReason, 'no-story-copy');
      assert.equal(workspace.store, ctx.store);
      assert.equal(workspace.story.phase, 'DEV');
    },
  },
  {
    name: 'structural: core/story-workspace.ts contains no state-dir literal (retired or canonical) and takes its paths from StoryStore',
    run: () => {
      const source = readFileSync(join(MAIN_SRC, 'core', 'story-workspace.ts'), 'utf-8');
      const retiredStateDir = ['.', 'lat', 'tice'].join('');
      assert.equal(source.split(retiredStateDir).length - 1, 0, `retired state-dir spelling found in core/story-workspace.ts`);
      assert.equal(source.split(`'${PROOF_OR_STOP_STATE_DIR}`).length - 1, 0, 'the canonical state-dir name must not be a literal either; it is derived via config -> proof-or-stop-paths -> brand-paths');
      assert.ok(source.includes('storyDirPath('), 'the helper must take the story directory from StoryStore.storyDirPath');
      assert.ok(source.includes('resolveGitCwd('), 'the helper must obtain gitCwd from resolveGitCwd');
      assert.match(source, /export function resolveStoryWorkspace\(/);
    },
  },
  {
    name: 'structural: the four implementations delegate to resolveStoryWorkspace and their own resolution logic is removed',
    run: () => {
      const failures: string[] = [];
      for (const site of WS_MIGRATED_SITES) {
        const source = readFileSync(join(MAIN_SRC, site.file), 'utf-8');
        if (!WS_HELPER_IMPORT_RE.test(source)) failures.push(`${site.file}: does not import resolveStoryWorkspace from core/story-workspace.js`);
        if (!source.includes('resolveStoryWorkspace(')) failures.push(`${site.file}: does not call resolveStoryWorkspace`);
        for (const token of site.removed) {
          if (source.includes(token)) failures.push(`${site.file}: still contains ${JSON.stringify(token)}`);
        }
      }
      assert.deepEqual(failures, [], failures.join('\n'));
    },
  },
  {
    name: 'validation_plan: the report (selectionDigest included) is identical from the story worktree and from the main checkout',
    run: () => {
      const fixture = buildWorkspaceFixture('plain');
      const fromWorktree = planFromRoot(fixture.worktreePath);
      const fromMain = planFromRoot(fixture.metadataRoot);
      assert.equal(fromWorktree.status, 'plan');
      assert.ok(planUnitIds(fromWorktree).includes(WS_WORKTREE_COMMAND_ID), 'the worktree view must select from the story branch inventory');
      assert.equal(fromMain.selectionDigest, fromWorktree.selectionDigest, 'selectionDigest must describe the story tree regardless of cwd');
      assert.deepEqual(fromMain, fromWorktree, 'the whole report must be identical from both roots');
    },
  },
  {
    name: 'validation_plan: DONE-story reads are unchanged (merged-and-removed reads the invocation root; a residual worktree is still read, matching the pre-CHK-003 unguarded behaviour)',
    run: () => {
      const removed = buildWorkspaceFixture('plain');
      markDoneAndRemoveWorktree(removed);
      const afterRemoval = planFromRoot(removed.metadataRoot);
      assert.equal(afterRemoval.storyPhase ?? afterRemoval.phase ?? 'DONE', 'DONE');
      assert.ok(!planUnitIds(afterRemoval).includes(WS_WORKTREE_COMMAND_ID), 'a removed worktree cannot be read: the plan must use the invocation root inventory');

      const residue = buildWorkspaceFixture('plain');
      markDoneKeepResidue(residue);
      const withResidue = planFromRoot(residue.metadataRoot);
      assert.ok(planUnitIds(withResidue).includes(WS_WORKTREE_COMMAND_ID), 'validation_plan keeps reading a residual DONE worktree (terminalPhaseGuard=false, its pre-CHK-003 behaviour)');
    },
  },
  {
    name: 'story_list: the projected phase and checklist are identical from the main checkout and from the story worktree, and a DONE story is read from main even with a residual worktree',
    run: () => {
      const fixture = buildWorkspaceFixture('plain');
      const fromMain = storyListRow(fixture.metadataRoot);
      const fromWorktree = storyListRow(fixture.worktreePath);
      assert.equal(fromMain.phase, 'TEST');
      assert.equal(fromMain.mainPhase, 'DEV', 'from main the row must carry the mirror phase');
      assert.equal(fromMain.checklist, '1/1');
      assert.equal(fromWorktree.phase, fromMain.phase);
      assert.equal(fromWorktree.checklist, fromMain.checklist);

      markDoneKeepResidue(fixture);
      const done = storyListRow(fixture.metadataRoot);
      assert.equal(done.phase, 'DONE', 'story_list keeps the phase-terminal guard: a DONE story is never projected from a residual worktree');
      assert.equal(done.mainPhase, undefined);
      assert.equal(done.checklist, '-', 'the checklist must come from main, not from the residual worktree');
    },
  },
  {
    // The wrapper-root layout is not asserted here: session_brief excludes a
    // story that detectZombieStories (story-query.ts, not one of the four
    // resolver implementations) flags, and on a wrapper root that detector
    // lists worktrees from the non-git metadata root and so flags the fixture
    // story as a zombie. The wrapper-root resolution is asserted on the helper
    // and on the local assurance projection above/below.
    name: 'session_brief: from the main checkout the active-story line carries authority:worktree and a cd hint; a DONE story with a residual worktree is not active',
    run: () => {
      const plain = buildWorkspaceFixture('plain');
      const plainBrief = briefFromRoot(plain.metadataRoot);
      assert.match(plainBrief, new RegExp(`${WS_STORY_ID} TEST \\(authority:worktree, mirror:DEV\\)`), `plain layout:\n${plainBrief}`);
      assert.ok(plainBrief.includes(`→ cd ${canonical(plain.worktreePath)}`), `plain layout must show the cd hint:\n${plainBrief}`);

      markDoneKeepResidue(plain);
      const doneBrief = briefFromRoot(plain.metadataRoot);
      assert.doesNotMatch(doneBrief, new RegExp(`${WS_STORY_ID} TEST`), `a DONE story must not be projected from its residual worktree:\n${doneBrief}`);
      assert.match(doneBrief, /Lifecycle DONE: 1\/1/, `the DONE story must be counted from main:\n${doneBrief}`);
    },
  },
  {
    name: 'local assurance projection: rows agree from both roots, the wrapper-root layout resolves the worktree, and DONE-story reads are unchanged (residue still read, removed worktree falls back to main)',
    run: () => {
      const plain = buildWorkspaceFixture('plain');
      const fromMain = assuranceRow(plain.metadataRoot, true);
      const fromWorktree = assuranceRow(plain.worktreePath, true);
      assert.equal(fromMain.stateSource, 'worktree');
      assert.equal(fromMain.mirrorPhase, 'DEV');
      assert.equal(fromMain.activePhase, 'TEST');
      assert.equal(canonical(fromMain.worktreePath ?? ''), canonical(plain.worktreePath));
      assert.equal(canonical(fromMain.activeCwd), canonical(plain.worktreePath));
      for (const key of ['stateSource', 'activePhase', 'worktreePath', 'activeCwd'] as const) {
        assert.deepEqual(fromWorktree[key], fromMain[key], `${key} must agree from both roots`);
      }

      const wrapper = buildWorkspaceFixture('wrapper-root');
      const wrapperRow = assuranceRow(wrapper.metadataRoot, true);
      assert.equal(wrapperRow.stateSource, 'worktree', 'the wrapper-root layout must resolve the linked worktree');
      assert.equal(canonical(wrapperRow.worktreePath ?? ''), canonical(wrapper.worktreePath));

      markDoneKeepResidue(plain);
      const residueRow = assuranceRow(plain.metadataRoot, false);
      assert.equal(residueRow.stateSource, 'worktree', 'the projection keeps reading a residual DONE worktree (its pre-CHK-003 unguarded behaviour)');
      assert.equal(residueRow.activePhase, 'TEST');

      const removed = buildWorkspaceFixture('plain');
      markDoneAndRemoveWorktree(removed);
      const removedRow = assuranceRow(removed.metadataRoot, false);
      assert.equal(removedRow.stateSource, 'main');
      assert.equal(removedRow.activePhase, 'DONE');
      assert.equal(removedRow.worktreePath, null);
    },
  },
]);

// ---------------------------------------------------------------------------
// Entry point.
// ---------------------------------------------------------------------------

const ok = runAll();
cleanupWorkspaceFixtures();
console.log(`${MARKER}: ${ok ? 'PASS' : 'FAIL'}`);
if (!ok) process.exit(1);
