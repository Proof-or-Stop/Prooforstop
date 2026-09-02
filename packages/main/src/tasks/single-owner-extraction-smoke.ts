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
 */

import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
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
import { resetConfigCache } from '../core/config.js';

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
// Entry point.
// ---------------------------------------------------------------------------

const ok = runAll();
console.log(`${MARKER}: ${ok ? 'PASS' : 'FAIL'}`);
if (!ok) process.exit(1);
