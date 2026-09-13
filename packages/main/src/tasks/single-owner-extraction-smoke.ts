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
 *
 * CHK-004 — mechanical audit of resolveGitCwd call sites:
 *   every handlers/*.ts file with a CALL EXPRESSION of the resolver (comments,
 *   strings, templates and regexes masked; import aliases resolved) is listed
 *   and classified `workspace-rooted` or `reads ctx.root: <story|checklist|
 *   config>`; the flagged list is the scope of the follow-up migration draft.
 */

import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
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
import { resolveStoryWorkspace } from '../core/story-workspace.js';
import type { ChecklistData, StoryInfo } from '../core/types.js';
import type { HandlerContext } from '../handlers/context.js';
import { createSessionHandlers } from '../handlers/session.js';
import { createStoryQueryHandlers } from '../handlers/story-query.js';
import { createValidationPlanHandlers } from '../handlers/validation-plan.js';
import { resolveDoneRequiredPolicy } from '../core/done-required-validation.js';
import { configuredValidationCommands } from '../handlers/verifier.js';
import { parseLegacyValidationCommandString } from '../core/validation-command-identity.js';
import { entriesFromSerialReference } from './full-suite-runner.js';

const MARKER = 'single-owner-extraction-smoke';
const HERE = dirname(fileURLToPath(import.meta.url));
// dist/tasks -> packages/main/src (the audited source tree).
const MAIN_SRC = resolve(HERE, '..', '..', 'src');
// packages/main/src -> repository root (root package.json / proof-or-stop.config.json).
const REPO_ROOT = resolve(MAIN_SRC, '..', '..', '..');

// F-007 -- the verification executor (core/validation-executor.ts, MAX_OUTPUT_CHARS = 12000) keeps only the
// first 12000 chars of a pinned command's stdout BEFORE matching the proof selector, so a `[PASS]` line printed
// past that offset is refused as absent. The audit block is therefore compact by default (one line per caller with
// its call lines as a column, F-010); the full rule text and the per-read line detail are printed only under
// SINGLE_OWNER_AUDIT_VERBOSE=1, and the last CHK-004 case asserts the default run stays under DEFAULT_STDOUT_BOUND_CHARS. Every write to this process's stdout is counted here (console.log goes
// through process.stdout.write; no child process inherits stdout) so that case measures the real output.
const AUDIT_VERBOSE = process.env.SINGLE_OWNER_AUDIT_VERBOSE === '1';
// F-009: 1000 chars of true headroom under the executor's 12000-char cap. If the bound case trips on an unrelated
// change (e.g. one more real caller), either shrink the default block (the `rule:` line, the call-line column, a case
// name) or raise this toward 12000 while keeping real headroom; do not print more by default.
const DEFAULT_STDOUT_BOUND_CHARS = 11_000;
/** Width of the default call-line column; wider lists overflow instead of padding every row (F-009). */
const CALL_COLUMN_WIDTH = 18;
let capturedStdoutChars = 0;
{
  const originalWrite = process.stdout.write;
  process.stdout.write = function (this: NodeJS.WriteStream, chunk: any, ...rest: any[]): boolean {
    capturedStdoutChars += typeof chunk === 'string' ? chunk.length : Buffer.from(chunk).toString('utf-8').length;
    return (originalWrite as any).call(this, chunk, ...rest);
  } as typeof process.stdout.write;
}

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
      const workspace = resolveStoryWorkspace(ctx, WS_STORY_ID);
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
        ((workspace.config.validate?.commands ?? []) as Array<{ id?: string }>).some((command) => command.id === WS_WORKTREE_COMMAND_ID),
        'config must be loaded from the linked worktree (it carries the worktree-only validate.commands entry)',
      );
    },
  },
  {
    name: 'helper: from inside the story worktree the same story resolves to the same gitCwd with source=invocation-root (same tree)',
    run: () => {
      const fixture = buildWorkspaceFixture('plain');
      const ctx = ctxAt(fixture.worktreePath);
      const workspace = resolveStoryWorkspace(ctx, WS_STORY_ID);
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
        const workspace = resolveStoryWorkspace(ctx, WS_STORY_ID, { terminalPhaseGuard });
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
      const guarded = resolveStoryWorkspace(ctx, WS_STORY_ID, { terminalPhaseGuard: true });
      assert.equal(guarded.source, 'invocation-root');
      assert.equal(guarded.rootReason, 'terminal-phase');
      assert.equal(guarded.store, ctx.store);
      assert.equal(guarded.story.phase, 'DONE');
      assert.equal(guarded.worktreePath, null);
      const byDefault = resolveStoryWorkspace(ctx, WS_STORY_ID);
      assert.equal(byDefault.rootReason, 'terminal-phase', 'the helper default must be the guarded behaviour');
      const unguarded = resolveStoryWorkspace(ctx, WS_STORY_ID, { terminalPhaseGuard: false });
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
      const workspace = resolveStoryWorkspace(ctx, WS_STORY_ID);
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
      assert.ok(!/\bjoin\s*\(/.test(source) && !source.includes('storyDirPath('), 'the helper builds no metadata path of its own (F-003 removed the unconsumed storyDir field); every read goes through StoryStore');
      assert.ok(source.includes('resolveGitCwdWithWorkspace('), 'the helper must obtain gitCwd and worktree from the shared authoritative observation');
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
    name: 'validation_plan: a DONE story is never planned from a linked worktree (merged-and-removed AND residual worktree both plan from the invocation root; rootReason=terminal-phase; the call site passes terminalPhaseGuard: true)',
    run: () => {
      const removed = buildWorkspaceFixture('plain');
      markDoneAndRemoveWorktree(removed);
      const afterRemoval = planFromRoot(removed.metadataRoot);
      assert.equal(afterRemoval.storyPhase, 'DONE');
      assert.ok(!planUnitIds(afterRemoval).includes(WS_WORKTREE_COMMAND_ID), 'a removed worktree cannot be read: the plan must use the invocation root inventory');

      // B-41c8 F-004 (closes B-a745 F-014): a DONE story whose worktree still
      // physically exists is residue, not authority. validation_plan must plan
      // it from the invocation root exactly like the removed case, not from
      // the leftover worktree.
      const residue = buildWorkspaceFixture('plain');
      markDoneKeepResidue(residue);
      const guarded = resolveStoryWorkspace(ctxAt(residue.metadataRoot), WS_STORY_ID);
      assert.equal(guarded.rootReason, 'terminal-phase', 'the helper reports why the residual worktree is refused');
      const withResidue = planFromRoot(residue.metadataRoot);
      assert.equal(withResidue.storyPhase, 'DONE');
      assert.ok(!planUnitIds(withResidue).includes(WS_WORKTREE_COMMAND_ID), 'validation_plan must NOT read a residual DONE worktree (terminalPhaseGuard must be on for this handler)');
      assert.deepEqual(planUnitIds(withResidue), planUnitIds(afterRemoval), 'the residual-worktree plan selects the same invocation-root inventory as the removed-worktree plan');

      const source = readFileSync(join(MAIN_SRC, 'handlers', 'validation-plan.ts'), 'utf-8');
      assert.ok(source.includes('terminalPhaseGuard: true'), 'validation-plan.ts must pass terminalPhaseGuard: true to resolveStoryWorkspace');
      assert.ok(!source.includes('terminalPhaseGuard: false'), 'validation-plan.ts must not opt out of the phase-terminal guard');
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
// CHK-004 — mechanical audit of resolveGitCwd call sites in handlers.
//
// Three hand-written enumerations of "which handlers call resolveGitCwd" were
// each wrong during this story's review history, and a file-level grep
// over-counts: validate-channel.ts only MENTIONS the resolver in a doc comment
// (it receives gitCwd threaded from review-preflight.ts as deps.gitCwd). This
// group is the mechanical replacement. It scans packages/main/src/handlers/*.ts
// for CALL EXPRESSIONS of the resolver and, for each real caller, classifies
// whether the same file still reads the story index, the checklist or
// validate.commands from the invocation root rather than through the CHK-003
// helper. The printed block is the scope of the follow-up draft
// `migrate-resolvegitcwd-callers-to-workspace`; this story does NOT migrate
// the flagged callers and a case asserts the flagged list is non-empty.
//
// Classification rule (file-level; deliberately conservative -- a false FLAG
// is the safe direction because the list feeds a migration, a false PASS
// would hide a caller from it):
//   caller   -- the file binds `resolveGitCwd` through an `import` whose
//               module specifier is core/story-signed-workspace-resolution
//               (`{ resolveGitCwd }`, `{ resolveGitCwd as x }` or
//               `* as ns` -> `ns.resolveGitCwd`) and calls that binding:
//               `<binding>(` in a CODE region, not preceded by `.` (a
//               property call on another object is not the resolver) and
//               not a `function <binding>(` declaration.
//   regions  -- `//` line comments, `/* */` block comments, '...' / "..."
//               strings, `...` template literals (their `${...}` expressions
//               are code) and /regex/ literals are masked before matching;
//               a token found only inside those regions is a mention.
//   ws var   -- an identifier assigned from `resolveStoryWorkspace(`.
//   story    -- `<receiver>.readStory(` whose receiver is not `<ws var>.store`,
//               or any `new StoryStore(` (a store the file rooted itself).
//   checklist-- `<receiver>.readChecklist(` whose receiver is not `<ws var>.store`.
//   config   -- `loadConfig(<arg>)` or `configuredValidationCommands(<arg>)`
//               (the validate.commands reader) whose first argument does not
//               start with `<ws var>.`.
//   workspace-rooted -- a caller with none of the three read kinds remaining
//               (printed with a `no ... read at all` note when vacuous);
//               otherwise `reads ctx.root: <story|checklist|config>`.
//   Destructured `const { store } = resolveStoryWorkspace(...)` is NOT
//   recognised as a ws var (its reads stay flagged: the safe direction).
//   handler  -- (B-41c8 F-005) a transitive ctx.root read through another
//               handler invoked on the same context: a method call on a
//               variable bound from `<factory>Handlers(<ctx>)`, an unbound
//               `<factory>Handlers(<ctx>).m(`, or any call that passes the
//               whole context (`<ctx>` bare, where <ctx> is `ctx` or any
//               parameter typed HandlerContext) to a callee NOT declared in
//               this file. A callee declared in this file is scanned in place
//               (its own reads are already in this file); resolveStoryWorkspace
//               is the helper itself; arrow parameter lists are not calls; a
//               factory constructed on a <ws var> is a workspace-rooted read.
//               Printed as `via-handler(<callee>, ...)`. The file-level scan
//               cannot see what the callee reads, so the label is the
//               conservative "reads ctx.root" -- a false FLAG is the safe
//               direction; proof-or-stop-handoff.ts was the false PASS.
//   config loaders are loadConfig, configuredValidationCommands and
//   resolveDoneRequiredPolicy (which loads config from its argument).
//
// RED committed these cases against the pre-CHK-004 hand method (a file-level
// grep: every file containing the token a caller, every token line a call
// line, nothing classified); GREEN replaced it with the masked scanner below.
// ---------------------------------------------------------------------------

type RootReadKind = 'story' | 'checklist' | 'config' | 'handler';
type RootRead = { kind: RootReadKind; via: string; line: number };
type ResolverScan = {
  hasToken: boolean;
  /** Lines with a call expression of the imported resolver binding. */
  callLines: number[];
  /** Lines where the token appears only inside a comment / string / template / regex region. */
  nonCodeMentionLines: number[];
  /** Lines with a code-region `resolveGitCwd(` that no import binds (a second resolver would show up here). */
  unboundCallLines: number[];
  workspaceRooted: boolean;
  /** Reads that went through a resolveStoryWorkspace() result (so `workspace-rooted` is not vacuous). */
  workspaceReads: number;
  remainingReads: RootRead[];
};
type ResolverCaller = ResolverScan & { file: string };
type ResolverMention = { file: string; lines: number[] };
type ResolverAudit = {
  handlersDir: string;
  scannedFiles: number;
  callers: ResolverCaller[];
  commentOnly: ResolverMention[];
  unboundCallMentions: ResolverMention[];
  flagged: ResolverCaller[];
};

const HANDLERS_DIR = join(MAIN_SRC, 'handlers');
const RESOLVER_TOKEN = 'resolveGitCwd';
const RESOLVER_MODULE_RE = /(^|\/)story-signed-workspace-resolution(\.js)?$/;

function handlerSourceFiles(dir: string): string[] {
  return readdirSync(dir).filter((name) => name.endsWith('.ts')).sort();
}

function lineOf(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i += 1) if (text.charCodeAt(i) === 10) line += 1;
  return line;
}

function sortedUnique(values: number[]): number[] {
  return [...new Set(values)].sort((a, b) => a - b);
}

// Region classification -- a single forward pass over the source that marks
// every character as code or as one of the masked region kinds. Newlines are
// kept in every region so line numbers survive masking. Regex literals are
// recognised by the standard previous-token heuristic (a `/` after `(`, `,`,
// `=`, `:`, `[`, `!`, `&`, `|`, `?`, `{`, `}`, `;`, an operator, the start of
// the file, or a keyword such as `return` / `typeof` starts a regex; after an
// identifier, a number, `)` or `]` it is division). No TypeScript compiler
// API: the handlers are plain enough for a line scanner and the probe case
// pins the tricky shapes.
const REGION_CODE = 0;
const REGION_LINE_COMMENT = 1;
const REGION_BLOCK_COMMENT = 2;
const REGION_STRING = 3;
const REGION_TEMPLATE = 4;
const REGION_REGEX = 5;

const REGEX_PREV_CHARS = new Set(['(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '<', '>', '~', '^']);
const REGEX_PREV_WORDS = new Set(['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case', 'do', 'else', 'yield', 'await']);
const WORD_CHAR_RE = /[\w$]/;

function classifyRegions(source: string): Uint8Array {
  const n = source.length;
  const kinds = new Uint8Array(n);
  const mark = (from: number, to: number, kind: number): void => { for (let k = from; k < to && k < n; k += 1) kinds[k] = kind; };
  let i = 0;
  let mode: 'code' | 'template' = 'code';
  // Brace depth of each open `${ ... }` expression (innermost last).
  const templateStack: number[] = [];
  let prevChar = '';
  let word = '';
  let rawPrevIsWord = false;
  const regexAllowed = (): boolean => {
    if (prevChar === '') return true;
    if (REGEX_PREV_CHARS.has(prevChar)) return true;
    if (WORD_CHAR_RE.test(prevChar)) return REGEX_PREV_WORDS.has(word);
    return false;
  };
  while (i < n) {
    const ch = source[i]!;
    const next = source[i + 1];
    if (mode === 'template') {
      if (ch === '\\') { mark(i, i + 2, REGION_TEMPLATE); i += 2; continue; }
      if (ch === '`') { mark(i, i + 1, REGION_TEMPLATE); i += 1; mode = 'code'; prevChar = '`'; rawPrevIsWord = false; continue; }
      if (ch === '$' && next === '{') { mark(i, i + 2, REGION_TEMPLATE); i += 2; templateStack.push(0); mode = 'code'; prevChar = '{'; rawPrevIsWord = false; continue; }
      mark(i, i + 1, REGION_TEMPLATE); i += 1; continue;
    }
    if (ch === '/' && next === '/') {
      const end = source.indexOf('\n', i);
      const stop = end < 0 ? n : end;
      mark(i, stop, REGION_LINE_COMMENT); i = stop; continue;
    }
    if (ch === '/' && next === '*') {
      const end = source.indexOf('*/', i + 2);
      const stop = end < 0 ? n : end + 2;
      mark(i, stop, REGION_BLOCK_COMMENT); i = stop; continue;
    }
    if (ch === "'" || ch === '"') {
      let j = i + 1;
      while (j < n && source[j] !== ch && source[j] !== '\n') { if (source[j] === '\\') j += 1; j += 1; }
      const stop = j < n && source[j] === ch ? j + 1 : j;
      mark(i, stop, REGION_STRING); i = stop; prevChar = ch; rawPrevIsWord = false; continue;
    }
    if (ch === '`') { mark(i, i + 1, REGION_TEMPLATE); i += 1; mode = 'template'; continue; }
    if (ch === '/' && regexAllowed()) {
      let j = i + 1;
      let inClass = false;
      while (j < n && source[j] !== '\n') {
        const c = source[j]!;
        if (c === '\\') { j += 2; continue; }
        if (c === '[') inClass = true;
        else if (c === ']') inClass = false;
        else if (c === '/' && !inClass) break;
        j += 1;
      }
      if (j < n && source[j] === '/') j += 1;
      while (j < n && /[a-z]/i.test(source[j]!)) j += 1;
      mark(i, j, REGION_REGEX); i = j; prevChar = ')'; rawPrevIsWord = false; continue;
    }
    kinds[i] = REGION_CODE;
    if (templateStack.length) {
      const top = templateStack.length - 1;
      if (ch === '{') templateStack[top] += 1;
      else if (ch === '}') {
        if (templateStack[top] === 0) { templateStack.pop(); kinds[i] = REGION_TEMPLATE; i += 1; mode = 'template'; continue; }
        templateStack[top] -= 1;
      }
    }
    if (WORD_CHAR_RE.test(ch)) {
      word = rawPrevIsWord ? word + ch : ch;
      rawPrevIsWord = true;
      prevChar = ch;
    } else {
      rawPrevIsWord = false;
      if (!/\s/.test(ch)) prevChar = ch;
    }
    i += 1;
  }
  return kinds;
}

/** The source with every non-code character (except newlines) replaced by a space. */
function maskNonCode(source: string, kinds: Uint8Array): string {
  let out = '';
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i]!;
    out += kinds[i] === REGION_CODE || ch === '\n' ? ch : ' ';
  }
  return out;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Local bindings of the resolver: named (possibly aliased) imports and namespace imports from core/story-signed-workspace-resolution. */
function resolverBindings(source: string, kinds: Uint8Array): { named: string[]; namespaces: string[] } {
  const named: string[] = [];
  const namespaces: string[] = [];
  const importRe = /\bimport\s+(type\s+)?([^'"]*?)\s*from\s*['"]([^'"]+)['"]/g;
  for (let match = importRe.exec(source); match; match = importRe.exec(source)) {
    if (kinds[match.index] !== REGION_CODE) continue;
    if (match[1]) continue;
    if (!RESOLVER_MODULE_RE.test(match[3]!)) continue;
    const clause = match[2]!;
    const namespace = /\*\s*as\s+([\w$]+)/.exec(clause);
    if (namespace) namespaces.push(namespace[1]!);
    const braces = /\{([^}]*)\}/.exec(clause);
    if (!braces) continue;
    for (const raw of braces[1]!.split(',')) {
      const spec = raw.trim();
      if (!spec || spec.startsWith('type ')) continue;
      const parsed = /^([\w$]+)(?:\s+as\s+([\w$]+))?$/.exec(spec);
      if (parsed && parsed[1] === RESOLVER_TOKEN) named.push(parsed[2] ?? parsed[1]!);
    }
  }
  return { named, namespaces };
}

function precededByFunctionKeyword(code: string, index: number): boolean {
  return /\bfunction\s*$/.test(code.slice(Math.max(0, index - 20), index));
}

function callLinesOf(code: string, pattern: RegExp): number[] {
  const lines: number[] = [];
  for (let match = pattern.exec(code); match; match = pattern.exec(code)) {
    const at = match.index + match[1]!.length;
    if (precededByFunctionKeyword(code, at)) continue;
    lines.push(lineOf(code, at));
  }
  return sortedUnique(lines);
}

/** Text of the first argument of the call whose `(` sits at `openIndex` (balanced parens). */
function firstArgumentAt(code: string, openIndex: number): string {
  let depth = 0;
  for (let i = openIndex; i < code.length; i += 1) {
    const ch = code[i]!;
    if (ch === '(') depth += 1;
    else if (ch === ')') { depth -= 1; if (depth === 0) return code.slice(openIndex + 1, i).split(',')[0]!.trim(); }
    else if (ch === ',' && depth === 1) return code.slice(openIndex + 1, i).trim();
  }
  return code.slice(openIndex + 1).trim();
}

const CONFIG_LOADERS = ['loadConfig', 'configuredValidationCommands', 'resolveDoneRequiredPolicy'] as const;
/** Callee tokens that can precede `(<ctx>)` without being a call of a function receiving the context. */
const NON_CALLEE_KEYWORDS: ReadonlySet<string> = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'function', 'async', 'await', 'typeof', 'yield', 'else', 'do', 'throw', 'void', 'delete']);
/** Receiving the context is the whole point of the CHK-003 helper; it is not a delegation. */
const DELEGATION_EXEMPT_CALLEES: ReadonlySet<string> = new Set(['resolveStoryWorkspace']);

/**
 * Names the file uses for its HandlerContext or the context's store: `ctx`, every parameter typed HandlerContext and
 * every parameter typed HandlerContext['store'] (the store rooted at ctx.root, so a non-local callee receiving either
 * may read ctx.root). `HandlerContext<...>` and sub-parts other than the store are not context names (F-011).
 * Runs on text whose string literals are kept (comments still masked) so the `'store'` subscript is visible.
 */
function contextNames(code: string): Set<string> {
  const names = new Set<string>(['ctx']);
  const re = /([\w$]+)\s*:\s*HandlerContext(?:\[\s*(?:'store'|"store")\s*\])?(?![\w$<\[])/g;
  for (let match = re.exec(code); match; match = re.exec(code)) names.add(match[1]!);
  return names;
}

/** Functions declared in this file (`function f(`, `function f<T>(`, `const f = (...) =>`, `const f = x =>`); calls to them are scanned in place, not as delegations. */
function localFunctionNames(code: string): Set<string> {
  const names = new Set<string>();
  const fnRe = /\bfunction\s+([\w$]+)\s*(?:<[^()]*?>\s*)?\(/g; // the optional generic clause may nest `<>` but not parentheses (F-011)
  for (let match = fnRe.exec(code); match; match = fnRe.exec(code)) names.add(match[1]!);
  const arrowRe = /\b(?:const|let|var)\s+([\w$]+)\s*=\s*(?:async\s+)?(?:\([^()]*\)\s*(?::[^=]*?)?=>|[\w$]+\s*=>)/g;
  for (let match = arrowRe.exec(code); match; match = arrowRe.exec(code)) names.add(match[1]!);
  return names;
}

/** The callee of the call whose argument list contains `argIndex`, or null when the enclosing `(` is not a call (grouping, arrow parameters). */
function enclosingCallee(code: string, argIndex: number): { name: string; open: number } | null {
  let depth = 0;
  for (let i = argIndex - 1; i >= 0; i -= 1) {
    const ch = code[i]!;
    if (ch === ')' || ch === ']' || ch === '}') { depth += 1; continue; }
    if (ch === '(' || ch === '[' || ch === '{') {
      if (depth > 0) { depth -= 1; continue; }
      if (ch !== '(') return null;
      let j = i - 1;
      while (j >= 0 && /\s/.test(code[j]!)) j -= 1;
      const end = j + 1;
      while (j >= 0 && /[\w$.]/.test(code[j]!)) j -= 1;
      const name = code.slice(j + 1, end);
      if (!name || name.startsWith('.') || name.endsWith('.') || /^\d/.test(name)) return null;
      return { name, open: i };
    }
  }
  return null;
}

/** Index of the `)` that closes the `(` at `openIndex` (or -1). */
function closingParenOf(code: string, openIndex: number): number {
  let depth = 0;
  for (let i = openIndex; i < code.length; i += 1) {
    if (code[i] === '(') depth += 1;
    else if (code[i] === ')') { depth -= 1; if (depth === 0) return i; }
  }
  return -1;
}

/** True when the call result is immediately used as a receiver (`f(ctx).m(`): a chained delegation, not a stored factory. */
function callIsChained(code: string, openIndex: number): boolean {
  const close = closingParenOf(code, openIndex);
  return close >= 0 && /^\s*[?!]?\./.test(code.slice(close + 1, close + 4));
}

function rootReadsOf(code: string, typeAnnotationCode: string = code): { reads: RootRead[]; workspaceReads: number } {
  const wsVars = new Set<string>();
  const wsRe = /(?:^|[^\w$.])([\w$]+)\s*=\s*resolveStoryWorkspace\s*\(/g;
  for (let match = wsRe.exec(code); match; match = wsRe.exec(code)) wsVars.add(match[1]!);
  const fromWorkspace = (expr: string): boolean => {
    const head = /^([\w$]+)\s*[?!]?\./.exec(expr);
    return Boolean(head && wsVars.has(head[1]!));
  };
  const reads: RootRead[] = [];
  let workspaceReads = 0;
  const storeRe = /([\w$]+(?:\s*[?!]?\.\s*[\w$]+)*)\s*[?!]?\.\s*(readStory|readChecklist)\s*\(/g;
  for (let match = storeRe.exec(code); match; match = storeRe.exec(code)) {
    const receiver = match[1]!.replace(/\s+|[?!]/g, '');
    if (/^([\w$]+)\.store$/.test(receiver) && wsVars.has(receiver.split('.')[0]!)) { workspaceReads += 1; continue; }
    reads.push({ kind: match[2] === 'readStory' ? 'story' : 'checklist', via: `${receiver}.${match[2]}`, line: lineOf(code, match.index) });
  }
  const storeCtorRe = /\bnew\s+StoryStore\s*\(/g;
  for (let match = storeCtorRe.exec(code); match; match = storeCtorRe.exec(code)) reads.push({ kind: 'story', via: 'new StoryStore', line: lineOf(code, match.index) });
  const configRe = new RegExp(`(^|[^\\w$.])(${CONFIG_LOADERS.join('|')})\\s*\\(`, 'g');
  for (let match = configRe.exec(code); match; match = configRe.exec(code)) {
    const at = match.index + match[1]!.length;
    if (precededByFunctionKeyword(code, at)) continue;
    const open = code.indexOf('(', at);
    if (fromWorkspace(firstArgumentAt(code, open))) { workspaceReads += 1; continue; }
    reads.push({ kind: 'config', via: match[2]!, line: lineOf(code, at) });
  }

  // B-41c8 F-005: transitive reads through handlers invoked on the context.
  const ctxNames = contextNames(typeAnnotationCode);
  const localFns = localFunctionNames(code);
  const mentionsWorkspace = (expr: string): boolean =>
    [...wsVars].some((ws) => new RegExp(`(^|[^\\w$.])${escapeRegExp(ws)}\\s*[?!]?\\.`).test(expr));
  const factoryVars = new Map<string, string>();
  const factoryRe = /\b(?:const|let|var)\s+([\w$]+)\s*=\s*([\w$]*Handlers)\s*\(/g;
  for (let match = factoryRe.exec(code); match; match = factoryRe.exec(code)) {
    const open = match.index + match[0].length - 1;
    const arg = firstArgumentAt(code, open);
    if (callIsChained(code, open)) continue; // `const x = f(ctx).m()` stores a result, not the factory; the bare-ctx rule flags it
    if (ctxNames.has(arg)) factoryVars.set(match[1]!, match[2]!);
    else if (mentionsWorkspace(arg)) workspaceReads += 1;
  }
  for (const [variable] of factoryVars) {
    const methodRe = new RegExp(`(^|[^\\w$.])${escapeRegExp(variable)}\\s*[?!]?\\.\\s*([\\w$]+)\\s*\\(`, 'g');
    for (let match = methodRe.exec(code); match; match = methodRe.exec(code)) {
      const at = match.index + match[1]!.length;
      reads.push({ kind: 'handler', via: `${variable}.${match[2]!}()`, line: lineOf(code, at) });
    }
  }
  const bareCtxRe = new RegExp(`[(,]\\s*(${[...ctxNames].map(escapeRegExp).join('|')})\\s*(?=[,)])`, 'g');
  for (let match = bareCtxRe.exec(code); match; match = bareCtxRe.exec(code)) {
    const token = match[1]!;
    const at = match.index + match[0].indexOf(token);
    const call = enclosingCallee(code, at);
    if (!call) continue;
    if (NON_CALLEE_KEYWORDS.has(call.name) || DELEGATION_EXEMPT_CALLEES.has(call.name) || localFns.has(call.name)) continue;
    // A factory stored in a variable is reported through that variable's method calls, not as a read of its own; a chained `f(ctx).m(` is a delegation here.
    if (/Handlers$/.test(call.name) && !callIsChained(code, call.open) && /(?:const|let|var)\s+[\w$]+\s*=\s*$/.test(code.slice(Math.max(0, call.open - call.name.length - 80), call.open - call.name.length))) continue;
    reads.push({ kind: 'handler', via: `${call.name}(${token})`, line: lineOf(code, at) });
  }
  const seen = new Set<string>();
  const unique = reads
    .filter((read) => { const key = `${read.via}@${read.line}`; if (seen.has(key)) return false; seen.add(key); return true; })
    .sort((a, b) => a.line - b.line || a.via.localeCompare(b.via));
  return { reads: unique, workspaceReads };
}

function scanResolverSource(source: string): ResolverScan {
  const tokenRe = new RegExp(`(^|[^\\w$])${RESOLVER_TOKEN}(?![\\w$])`, 'g');
  const hasToken = tokenRe.test(source);
  if (!hasToken) return { hasToken: false, callLines: [], nonCodeMentionLines: [], unboundCallLines: [], workspaceRooted: true, workspaceReads: 0, remainingReads: [] };
  const kinds = classifyRegions(source);
  const code = maskNonCode(source, kinds);
  const bindings = resolverBindings(source, kinds);
  const callLines: number[] = [];
  for (const local of bindings.named) callLines.push(...callLinesOf(code, new RegExp(`(^|[^\\w$.])${escapeRegExp(local)}\\s*\\(`, 'g')));
  for (const ns of bindings.namespaces) callLines.push(...callLinesOf(code, new RegExp(`(^|[^\\w$.])${escapeRegExp(ns)}\\s*\\.\\s*${RESOLVER_TOKEN}\\s*\\(`, 'g')));
  const unboundCallLines = bindings.named.includes(RESOLVER_TOKEN)
    ? []
    : callLinesOf(code, new RegExp(`(^|[^\\w$.])${RESOLVER_TOKEN}\\s*\\(`, 'g'));
  const mentionLines: number[] = [];
  tokenRe.lastIndex = 0;
  for (let match = tokenRe.exec(source); match; match = tokenRe.exec(source)) {
    const at = match.index + match[1]!.length;
    if (kinds[at] !== REGION_CODE) mentionLines.push(lineOf(source, at));
  }
  // Type annotations such as HandlerContext['store'] live partly in a string region; keep strings for the context-name scan (F-011).
  const typeAnnotationCode = maskNonCode(source, kinds.map((kind) => (kind === REGION_STRING ? REGION_CODE : kind)));
  const { reads: remainingReads, workspaceReads } = rootReadsOf(code, typeAnnotationCode);
  return {
    hasToken: true,
    callLines: sortedUnique(callLines),
    nonCodeMentionLines: sortedUnique(mentionLines),
    unboundCallLines,
    workspaceRooted: remainingReads.length === 0,
    workspaceReads,
    remainingReads,
  };
}

function auditResolverCallSites(handlersDir: string): ResolverAudit {
  const files = handlerSourceFiles(handlersDir);
  const callers: ResolverCaller[] = [];
  const commentOnly: ResolverMention[] = [];
  const unboundCallMentions: ResolverMention[] = [];
  for (const file of files) {
    const scan = scanResolverSource(readFileSync(join(handlersDir, file), 'utf-8'));
    if (!scan.hasToken) continue;
    if (scan.callLines.length) callers.push({ file, ...scan });
    else if (scan.unboundCallLines.length) unboundCallMentions.push({ file, lines: scan.unboundCallLines });
    else commentOnly.push({ file, lines: scan.nonCodeMentionLines });
  }
  return { handlersDir, scannedFiles: files.length, callers, commentOnly, unboundCallMentions, flagged: callers.filter((caller) => !caller.workspaceRooted) };
}

function describeReads(reads: RootRead[]): string {
  const byVia = new Map<string, number[]>();
  for (const read of reads) byVia.set(read.via, [...(byVia.get(read.via) ?? []), read.line]);
  return [...byVia.entries()].map(([via, lines]) => `${via} ${sortedUnique(lines).map((line) => `L${line}`).join(',')}`).join('; ');
}

/** The label of a workspace-rooted caller that read nothing at all. One constant, shared with the F-005 guard below, so a rename cannot desynchronise them (F-008). */
const VACUOUS_WORKSPACE_LABEL = 'workspace-rooted (no story/checklist/config read and no delegation on ctx at all)';

function classificationOf(caller: ResolverScan): string {
  if (caller.workspaceRooted) return caller.workspaceReads > 0 ? 'workspace-rooted' : VACUOUS_WORKSPACE_LABEL;
  const kinds: string[] = (['story', 'checklist', 'config'] as RootReadKind[]).filter((kind) => caller.remainingReads.some((read) => read.kind === kind));
  const delegations = [...new Set(caller.remainingReads.filter((read) => read.kind === 'handler').map((read) => read.via.replace(/\(.*\)$/, '')))].sort();
  if (delegations.length) kinds.push(`via-handler(${delegations.join(', ')})`);
  return `reads ctx.root: ${kinds.join(', ')}`;
}

function renderResolverAudit(report: ResolverAudit, verbose: boolean = AUDIT_VERBOSE): string[] {
  const width = Math.max(...report.callers.map((caller) => caller.file.length), 1);
  const lines: string[] = [];
  lines.push('resolveGitCwd call sites');
  lines.push(`  scope: packages/main/src/handlers/*.ts -- ${report.scannedFiles} files scanned, ${report.callers.length} real callers, ${report.commentOnly.length} comment-only mentions, ${report.unboundCallMentions.length} unbound code mentions`);
  if (verbose) {
    lines.push('  rule: caller = a CALL EXPRESSION of the resolver binding imported from core/story-signed-workspace-resolution (aliases resolved; comments, strings, templates, regexes masked);');
    lines.push(`        workspace-rooted = every readStory/readChecklist receiver is <ws>.store, no \`new StoryStore(\`, every ${CONFIG_LOADERS.join('/')} argument starts with <ws>., and no handler is invoked on the context, where <ws> is assigned from resolveStoryWorkspace(); otherwise reads ctx.root: <story|checklist|config|via-handler(...)>`);
    lines.push('        via-handler(<callee>) = a transitive ctx.root read (B-41c8 F-005): a method on a <factory>Handlers(<ctx>) result, an unbound <factory>Handlers(<ctx>).m(), or a callee outside this file receiving the bare context or the context\'s store (a HandlerContext[\'store\'] parameter); local callees, arrow parameters and resolveStoryWorkspace itself are not delegations');
  } else {
    // F-007: the default block must fit the verification executor's selector window with the rest of the smoke;
    // the full rule text and the per-read lines are printed under SINGLE_OWNER_AUDIT_VERBOSE=1.
    lines.push('  rule: a caller is a call expression of the imported resolver binding, classified by its remaining ctx.root reads; full rule and per-read lines: SINGLE_OWNER_AUDIT_VERBOSE=1');
  }
  lines.push(`  callers (${report.callers.length}):`);
  const callsOf = (caller: ResolverCaller): string => caller.callLines.map((line) => `L${line}`).join(',');
  const callWidth = Math.min(Math.max(...report.callers.map((caller) => callsOf(caller).length), 1), CALL_COLUMN_WIDTH);
  for (const caller of report.callers) {
    const calls = callsOf(caller);
    if (!verbose) {
      // F-010: the call lines are printed by default as one compact column; per-read detail stays verbose-only.
      lines.push(`    ${caller.file}  ${calls}  ${classificationOf(caller)}`);
      continue;
    }
    const detail = caller.remainingReads.length ? `  -- ${describeReads(caller.remainingReads)}` : '';
    lines.push(`    ${caller.file.padEnd(width)}  calls ${calls.padEnd(18)}  ${classificationOf(caller)}${detail}`);
  }
  lines.push(`  comment-only mentions (${report.commentOnly.length}):`);
  for (const mention of report.commentOnly) lines.push(`    ${mention.file.padEnd(width)}  ${mention.lines.map((line) => `L${line}`).join(', ')}`);
  if (report.unboundCallMentions.length) {
    lines.push(`  code mentions without an import binding (${report.unboundCallMentions.length}):`);
    for (const mention of report.unboundCallMentions) lines.push(`    ${mention.file.padEnd(width)}  ${mention.lines.map((line) => `L${line}`).join(', ')}`);
  }
  lines.push(`  flagged callers (reads ctx.root): ${report.flagged.length} of ${report.callers.length}`);
  return lines;
}

/** Case-local expectation for a real file: code-level `resolveGitCwd(` lines by a naive line rule (used only where the file is known to have no tricky regions). */
function naiveCodeLevelCallLines(source: string): number[] {
  return source.split('\n').flatMap((line, index) => {
    const trimmed = line.trimStart();
    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return [];
    return line.includes(`${RESOLVER_TOKEN}(`) ? [index + 1] : [];
  });
}

const ALIAS_FIXTURE_NAME = 'zz-chk004-alias-fixture.ts';
const ALIAS_FIXTURE_LINES = [
  "import { resolveGitCwd as resolveWorkspaceCwd } from '../core/story-signed-workspace-resolution.js';", // L1
  "import type { HandlerContext } from './context.js';", // L2
  '', // L3
  '// resolveGitCwd({ mention: "in a line comment" })', // L4
  '/* resolveGitCwd( in a block comment */', // L5
  "const LABEL = 'resolveGitCwd(' + \"resolveGitCwd(\";", // L6
  '', // L7
  'export function fixtureGitCwd(ctx: HandlerContext, storyId: string): string {', // L8
  '  const checklist = ctx.store.readChecklist(storyId);', // L9
  '  void checklist;', // L10
  '  return resolveWorkspaceCwd({ store: ctx.store, storyId, metadataRoot: ctx.root, projectRoot: ctx.root }) + LABEL;', // L11
  '}', // L12
  '',
];
const ALIAS_FIXTURE_CALL_LINE = 11;
const ALIAS_FIXTURE_MENTION_LINES = [4, 5, 6];
const ALIAS_FIXTURE_READ_LINE = 9;

// Scanner probe: one synthetic source exercising every masked region kind.
const SCANNER_PROBE_LINES = [
  "import { resolveGitCwd as aliasCwd } from '../core/story-signed-workspace-resolution.js';", // L1
  '// resolveGitCwd({ line: "comment" })', // L2 mention
  '/* resolveGitCwd(', // L3 mention
  '   continued) */', // L4
  "const s = 'resolveGitCwd(' + \"resolveGitCwd(\"; // resolveGitCwd(", // L5 mention (strings + trailing comment)
  'const t = `resolveGitCwd(${aliasCwd({ store, storyId, metadataRoot: root, projectRoot: root })}) ${"resolveGitCwd("}`;', // L6 call inside ${} + mentions
  "const re = /'\"\\/\\/ resolveGitCwd\\(/g; const half = total / 2 / count;", // L7 mention (regex literal), divisions are not regexes
  'const x = aliasCwd({ store, storyId, metadataRoot: root, projectRoot: root });', // L8 call
  'const y = other.resolveGitCwd({}); const z = other.aliasCwd({}); const k = typeof aliasCwd;', // L9 foreign-object calls: neither call nor mention
  "const w = aliasCwd  ({ store, storyId, metadataRoot: root, projectRoot: root }); const label = `${'aliasCwd('}`;", // L10 call (space before paren); string inside ${} masked
  'const ws = resolveStoryWorkspace(ctx, storyId); const a = ws.store.readStory(storyId); const b = loadConfig(ws.gitCwd); const c = ws.store.readChecklist(storyId);', // L11 workspace-rooted reads
  'const bad = new StoryStore(ctx.root); const idx = ctx.store.readStory(storyId); const cfg = loadConfig(join(ctx.root, "x")); const cmds = configuredValidationCommands(ctx.root);', // L12 ctx.root reads
  '',
];
const SCANNER_PROBE_CALL_LINES = [6, 8, 10];
const SCANNER_PROBE_MENTION_LINES = [2, 3, 5, 6, 7];
const SCANNER_PROBE_READ_LINE = 12;

// F-005 probe: transitive ctx.root reads through handlers invoked with ctx.
const DELEGATION_PROBE_LINES = [
  "import { resolveGitCwd } from '../core/story-signed-workspace-resolution.js';", // L1
  "import { createStoryQueryHandlers } from './story-query.js';", // L2
  "import { currentCertificationIdentity } from './certification-window.js';", // L3
  "import { resolveDoneRequiredPolicy } from '../core/done-required-validation.js';", // L4
  'function localHelper(ctx: HandlerContext, storyId: string): string { return resolveGitCwd({ store: ctx.store, storyId, metadataRoot: ctx.root, projectRoot: ctx.root }); }', // L5 call; a local function is scanned in place, not flagged as a callee
  'export function createProbeHandlers(ctx: HandlerContext) {', // L6
  '  const storyHandlers = createStoryQueryHandlers(ctx);', // L7 factory bound on ctx (not itself a read)
  '  const summary = storyHandlers.story_get({ storyId: "B-1", detail: true });', // L8 via-handler(storyHandlers.story_get)
  '  const identity = currentCertificationIdentity(ctx, "B-1");', // L9 via-handler(currentCertificationIdentity)
  '  const policy = resolveDoneRequiredPolicy(ctx.root);', // L10 config (resolveDoneRequiredPolicy loads config from its argument)
  '  const local = localHelper(ctx, "B-1");', // L11 local callee: not flagged
  '  const cb = (ctx) => ctx; const acb = async (ctx) => ctx;', // L12 arrow parameter lists: not calls
  '  const ws = resolveStoryWorkspace(ctx, "B-1"); const wsHandlers = createStoryQueryHandlers({ store: ws.store, root: ws.gitCwd }); const wsSummary = wsHandlers.story_get({ storyId: "B-1" });', // L13 the helper itself and a ws-derived handler set: workspace-rooted
  '  const inline = createStoryQueryHandlers(ctx).story_list({}); const wsPolicy = resolveDoneRequiredPolicy(ws.gitCwd);', // L14 unbound factory on ctx: via-handler(createStoryQueryHandlers); ws-derived config: workspace-rooted
  '  return [summary, identity, policy, local, cb, acb, wsSummary, inline, wsPolicy];', // L15
  '}', // L16
  '',
];

// F-011 probe: a generic local function and a store-typed parameter must not become delegations.
const GENERIC_LOCAL_PROBE_LINES = [
  "import { resolveGitCwd } from '../core/story-signed-workspace-resolution.js';", // L1
  "import { assertCwdInWorktree } from './session.js';", // L2
  'function withLock<T>(ctx: HandlerContext, storyId: string, fn: () => T): T { return fn(); }', // L3 generic local function: a local callee
  "function checkCwd(store: HandlerContext['store'], storyId: string): void { assertCwdInWorktree(store, storyId); }", // L4 `store` is the context's store (rooted at ctx.root): a non-local callee receiving it is a delegation
  'export async function probe<T extends string>(ctx: HandlerContext, storyId: T): Promise<string> {', // L5 generic exported async function
  '  const gitCwd = resolveGitCwd({ store: ctx.store, storyId, metadataRoot: ctx.root, projectRoot: ctx.root });', // L6 call
  '  return withLock(ctx, storyId, () => { checkCwd(ctx.store, storyId); return gitCwd; });', // L7 generic local callees receiving bare ctx / the store are scanned in place, not flagged
  '}', // L8
  'function checkCwdQuoted(dq: HandlerContext["store"], storyId: string): void { assertCwdInWorktree(dq, storyId); }', // L9 the same store parameter with a double-quoted subscript (no formatter pins quote style here; finding.ts:564 already spells a type subscript this way): a context name and a delegation (F-013)
  '',
];

function readRootPackageJson(): { scripts: Record<string, string> } {
  return JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf-8')) as { scripts: Record<string, string> };
}

/** Chars the audit case actually printed (whichever mode), so the bound case can swap in the default rendering. */
let printedAuditChars = 0;
const DEFAULT_STDOUT_BOUND_CASE_NAME = 'bound (F-007): the default (SINGLE_OWNER_AUDIT_VERBOSE unset) total stdout of this smoke is under 11000 chars';

function renderedChars(lines: string[]): number {
  return lines.reduce((total, line) => total + line.length + 1, 0);
}

/** F-005 regression guard: the two aggregator files that once printed the vacuous label as a false PASS; the label is the classifier's own constant (F-008). */
const F005_GUARDED_FILES = ['proof-or-stop-handoff.ts', 'done-required-validation.ts'] as const;
function printsVacuousWorkspaceLabelFor(lines: string[], files: readonly string[]): boolean {
  return lines.some((line) => line.includes(VACUOUS_WORKSPACE_LABEL) && files.some((file) => line.includes(file)));
}

group('CHK-004 resolveGitCwd call sites in handlers are enumerated mechanically and classified', [
  {
    name: 'audit: every handler with a real resolveGitCwd call expression is listed with its call lines and a classification, and the block headed `resolveGitCwd call sites` is printed',
    run: () => {
      const started = Date.now();
      const report = auditResolverCallSites(HANDLERS_DIR);
      const elapsedMs = Date.now() - started;
      const rendered = renderResolverAudit(report, AUDIT_VERBOSE);
      for (const line of rendered) console.log(line);
      printedAuditChars = renderedChars(rendered);
      assert.ok(report.callers.length > 0, 'at least one handler calls the resolver');
      assert.ok(elapsedMs < 10_000, `the audit is a line scan and must finish well under the budget (took ${elapsedMs}ms)`);
      for (const caller of report.callers) {
        assert.ok(caller.callLines.length > 0, `${caller.file}: a caller must have at least one call line`);
        const source = readFileSync(join(HANDLERS_DIR, caller.file), 'utf-8');
        assert.ok(source.includes('story-signed-workspace-resolution'), `${caller.file}: a real call needs an import binding for the resolver; a file without one is a mention, not a caller`);
        assert.ok(caller.workspaceRooted || caller.remainingReads.length > 0, `${caller.file}: a flagged caller must name at least one remaining ctx.root read`);
        assert.ok(!caller.workspaceRooted || caller.remainingReads.length === 0, `${caller.file}: a workspace-rooted caller has no remaining ctx.root read`);
      }
      // The default block is one `<file>  <call lines>  <classification>` line per caller (F-010: the call lines are
      // printed by default, compactly); per-read detail stays verbose-only so the block fits the executor's selector window (F-007).
      const compact = renderResolverAudit(report, false);
      const verboseLines = renderResolverAudit(report, true);
      for (const caller of report.callers) {
        assert.equal(compact.filter((line) => line.startsWith(`    ${caller.file} `)).length, 1, `${caller.file}: exactly one default line`);
        assert.ok(compact.some((line) => line.startsWith(`    ${caller.file} `) && line.includes(`  ${caller.callLines.map((n) => `L${n}`).join(',')}  `)), `${caller.file}: the default line lists its call lines`);
        assert.ok(compact.some((line) => line.startsWith(`    ${caller.file} `) && line.trimEnd().endsWith(classificationOf(caller))), `${caller.file}: the default line ends with its classification`);
        assert.ok(verboseLines.some((line) => line.startsWith(`    ${caller.file} `) && line.includes(`calls ${caller.callLines.map((n) => `L${n}`).join(',')}`)), `${caller.file}: the verbose line carries its call lines`);
      }
    },
  },
  {
    name: 'completeness: every handler file containing the raw token appears in exactly one of callers / comment-only mentions / unbound code mentions',
    run: () => {
      const report = auditResolverCallSites(HANDLERS_DIR);
      const rawFiles = handlerSourceFiles(HANDLERS_DIR).filter((file) => readFileSync(join(HANDLERS_DIR, file), 'utf-8').includes(RESOLVER_TOKEN)).sort();
      const listed = [...report.callers.map((c) => c.file), ...report.commentOnly.map((m) => m.file), ...report.unboundCallMentions.map((m) => m.file)];
      assert.deepEqual([...listed].sort(), rawFiles, 'the three lists partition the raw-grep file set');
      assert.equal(new Set(listed).size, listed.length, 'no file is listed twice');
      for (const mention of report.commentOnly) assert.ok(mention.lines.length > 0, `${mention.file}: a comment-only mention must name the mention lines`);
    },
  },
  {
    name: 'edge: validate-channel.ts is a comment-only mention (it receives gitCwd threaded from review-preflight.ts as deps.gitCwd); review-preflight.ts is a real caller whose call lines are exactly its code-level resolveGitCwd( lines',
    run: () => {
      const report = auditResolverCallSites(HANDLERS_DIR);
      const channel = report.commentOnly.find((mention) => mention.file === 'validate-channel.ts');
      assert.ok(channel, 'validate-channel.ts must be listed under comment-only mentions');
      assert.ok(!report.callers.some((caller) => caller.file === 'validate-channel.ts'), 'validate-channel.ts must not be a caller');
      const preflight = report.callers.find((caller) => caller.file === 'review-preflight.ts');
      assert.ok(preflight, 'review-preflight.ts must be a real caller');
      const expected = naiveCodeLevelCallLines(readFileSync(join(HANDLERS_DIR, 'review-preflight.ts'), 'utf-8'));
      assert.ok(expected.length > 0, 'review-preflight.ts has at least one code-level call');
      assert.deepEqual(preflight!.callLines, expected, 'call lines are the code-level call lines, never the import line');
      assert.equal(preflight!.workspaceRooted, false, 'review-preflight.ts reads deps.store (threaded ctx.store) and is flagged');
    },
  },
  {
    name: 'edge: a temporary handler file importing the resolver under an alias is detected as a caller at the aliased call line only, classified by its own reads, and cleaned up',
    run: () => {
      const dir = mkdtempSync(join(tmpdir(), 'chk004-alias-'));
      try {
        for (const real of ['validate-channel.ts', 'review-preflight.ts']) copyFileSync(join(HANDLERS_DIR, real), join(dir, real));
        writeFileSync(join(dir, ALIAS_FIXTURE_NAME), ALIAS_FIXTURE_LINES.join('\n'));
        const report = auditResolverCallSites(dir);
        assert.equal(report.scannedFiles, 3);
        assert.deepEqual(report.callers.map((caller) => caller.file), ['review-preflight.ts', ALIAS_FIXTURE_NAME]);
        assert.deepEqual(report.commentOnly.map((mention) => mention.file), ['validate-channel.ts']);
        const fixture = report.callers.find((caller) => caller.file === ALIAS_FIXTURE_NAME)!;
        assert.deepEqual(fixture.callLines, [ALIAS_FIXTURE_CALL_LINE], 'only the aliased call expression is a call (not the import, comment or string lines)');
        assert.deepEqual(fixture.nonCodeMentionLines, ALIAS_FIXTURE_MENTION_LINES);
        assert.equal(fixture.workspaceRooted, false);
        assert.deepEqual(fixture.remainingReads, [{ kind: 'checklist', via: 'ctx.store.readChecklist', line: ALIAS_FIXTURE_READ_LINE }]);
        assert.deepEqual(report.flagged.map((caller) => caller.file), ['review-preflight.ts', ALIAS_FIXTURE_NAME]);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
      assert.ok(!existsSync(dir), 'the temp dir is removed');
      assert.ok(!existsSync(join(HANDLERS_DIR, ALIAS_FIXTURE_NAME)), 'nothing was written into the live handlers directory');
    },
  },
  {
    name: 'adversarial: the scanner ignores the token inside line comments, block comments, string / template / regex literals and foreign-object calls, follows template ${} expressions, and separates workspace-rooted reads from ctx.root reads',
    run: () => {
      const scan = scanResolverSource(SCANNER_PROBE_LINES.join('\n'));
      assert.equal(scan.hasToken, true);
      assert.deepEqual(scan.callLines, SCANNER_PROBE_CALL_LINES, 'call lines');
      assert.deepEqual(scan.nonCodeMentionLines, SCANNER_PROBE_MENTION_LINES, 'non-code mention lines');
      assert.deepEqual(scan.unboundCallLines, [], 'a foreign-object `.resolveGitCwd(` is not an unbound call');
      assert.equal(scan.workspaceRooted, false);
      assert.equal(scan.workspaceReads, 3, 'the three L11 reads through the ws var are counted as workspace-rooted');
      assert.ok(scan.remainingReads.every((read) => read.line === SCANNER_PROBE_READ_LINE), `no workspace-rooted read (L11) is flagged: ${JSON.stringify(scan.remainingReads)}`);
      assert.deepEqual(
        scan.remainingReads.map((read) => `${read.kind}:${read.via}`).sort(),
        ['config:configuredValidationCommands', 'config:loadConfig', 'story:ctx.store.readStory', 'story:new StoryStore'],
      );
    },
  },
  {
    name: 'edge (F-005): an aggregator that delegates to handlers constructed on ctx is flagged, never workspace-rooted: proof-or-stop-handoff.ts (storyHandlers.story_get / summaryHandlers.summary_get) and done-required-validation.ts (currentCertificationIdentity(ctx); resolveDoneRequiredPolicy(ctx.root) loads config)',
    run: () => {
      const report = auditResolverCallSites(HANDLERS_DIR);
      const handoff = report.callers.find((caller) => caller.file === 'proof-or-stop-handoff.ts');
      assert.ok(handoff, 'proof-or-stop-handoff.ts is a real caller');
      assert.equal(handoff!.workspaceRooted, false, 'proof-or-stop-handoff.ts reads story/checklist data through story_get / summary_get on the same ctx; a false PASS must not hide it');
      const handoffVias = handoff!.remainingReads.filter((read) => (read.kind as string) === 'handler').map((read) => read.via);
      assert.ok(handoffVias.includes('storyHandlers.story_get()'), `story_get delegation must be listed: ${JSON.stringify(handoff!.remainingReads)}`);
      assert.ok(handoffVias.includes('summaryHandlers.summary_get()'), `summary_get delegation must be listed: ${JSON.stringify(handoff!.remainingReads)}`);
      assert.match(classificationOf(handoff!), /^reads ctx\.root: .*via-handler\(/, 'the printed classification names the delegation');
      assert.ok(report.flagged.some((caller) => caller.file === 'proof-or-stop-handoff.ts'), 'proof-or-stop-handoff.ts is in the flagged list');

      const doneRequired = report.callers.find((caller) => caller.file === 'done-required-validation.ts');
      assert.ok(doneRequired, 'done-required-validation.ts is a real caller');
      assert.equal(doneRequired!.workspaceRooted, false, 'done-required-validation.ts loads config from ctx.root and delegates to certification-window on ctx');
      assert.ok(doneRequired!.remainingReads.some((read) => read.kind === 'config' && read.via === 'resolveDoneRequiredPolicy'), `resolveDoneRequiredPolicy(ctx.root) is a config read: ${JSON.stringify(doneRequired!.remainingReads)}`);
      assert.ok(doneRequired!.remainingReads.some((read) => (read.kind as string) === 'handler' && read.via === 'currentCertificationIdentity(ctx)'), `currentCertificationIdentity(ctx) is a delegation: ${JSON.stringify(doneRequired!.remainingReads)}`);
      assert.ok(report.flagged.some((caller) => caller.file === 'done-required-validation.ts'), 'done-required-validation.ts is in the flagged list');
      assert.ok(!printsVacuousWorkspaceLabelFor(renderResolverAudit(report), F005_GUARDED_FILES), 'neither file may print the vacuous workspace-rooted label');
    },
  },
  {
    name: 'guard (F-008): the guarded vacuous label is the classifier\'s own, and the guard fires when proof-or-stop-handoff.ts prints it',
    run: () => {
      const vacuous: ResolverScan = { hasToken: true, callLines: [3], nonCodeMentionLines: [], unboundCallLines: [], workspaceRooted: true, workspaceReads: 0, remainingReads: [] };
      assert.equal(classificationOf(vacuous), VACUOUS_WORKSPACE_LABEL, 'the guard must look for the label the classifier actually prints; a renamed label silently makes the guard vacuous (F-008)');
      const synthetic: ResolverAudit = { handlersDir: HANDLERS_DIR, scannedFiles: 1, callers: [{ file: 'proof-or-stop-handoff.ts', ...vacuous }], commentOnly: [], unboundCallMentions: [], flagged: [] };
      assert.ok(printsVacuousWorkspaceLabelFor(renderResolverAudit(synthetic, false), F005_GUARDED_FILES), 'the default rendering of a vacuous proof-or-stop-handoff.ts line must trip the guard');
      assert.ok(printsVacuousWorkspaceLabelFor(renderResolverAudit(synthetic, true), F005_GUARDED_FILES), 'the verbose rendering of a vacuous proof-or-stop-handoff.ts line must trip the guard');
      assert.ok(!printsVacuousWorkspaceLabelFor(renderResolverAudit({ ...synthetic, callers: [{ file: 'other.ts', ...vacuous }] }, false), F005_GUARDED_FILES), 'a vacuous label on an unrelated file does not trip this guard');
    },
  },
  {
    name: 'adversarial (F-005): the delegation rule flags handler-factory methods bound on ctx, unbound factory calls on ctx and non-local callees receiving bare ctx; it ignores local callees, arrow parameter lists, the helper itself and ws-derived handler sets',
    run: () => {
      const scan = scanResolverSource(DELEGATION_PROBE_LINES.join('\n'));
      assert.deepEqual(scan.callLines, [5], 'the only resolver call is in the local helper');
      assert.equal(scan.workspaceRooted, false);
      const handlerReads = scan.remainingReads.filter((read) => (read.kind as string) === 'handler').map((read) => `${read.via}@L${read.line}`).sort();
      assert.deepEqual(handlerReads, [
        'createStoryQueryHandlers(ctx)@L14',
        'currentCertificationIdentity(ctx)@L9',
        'storyHandlers.story_get()@L8',
      ].sort(), 'exactly the three delegations are flagged (not the local helper, the arrows, resolveStoryWorkspace or the ws-derived handler set)');
      assert.deepEqual(scan.remainingReads.filter((read) => read.kind === 'config').map((read) => `${read.via}@L${read.line}`), ['resolveDoneRequiredPolicy@L10'], 'resolveDoneRequiredPolicy(ctx.root) is a config read; resolveDoneRequiredPolicy(ws.gitCwd) is not');
      assert.equal(scan.workspaceReads, 2, 'the ws-derived handler set and the ws-derived policy load count as workspace-rooted reads');
      assert.match(classificationOf(scan), /^reads ctx\.root: config, via-handler\(createStoryQueryHandlers, currentCertificationIdentity, storyHandlers\.story_get\)$/);
    },
  },
  {
    name: 'adversarial (F-011): generic local callees are local; HandlerContext[\'store\'] is a context name, HandlerContext<...> is not; no caller is flagged via its own function',
    run: () => {
      const probe = GENERIC_LOCAL_PROBE_LINES.join('\n');
      assert.deepEqual([...localFunctionNames(probe)].sort(), ['checkCwd', 'checkCwdQuoted', 'probe', 'withLock'], 'generic, async and exported function declarations are all local');
      assert.deepEqual([...localFunctionNames('export async function nested<T extends Map<string, Foo<T>>>(ctx: HandlerContext): T { }')], ['nested'], 'a nested generic clause is tolerated');
      const names = contextNames(`${probe}\nfunction g(context: HandlerContext, other: HandlerContext | undefined, typed: HandlerContext<Foo>, sub: HandlerContext['root']) {}`);
      assert.deepEqual([...names].sort(), ['context', 'ctx', 'dq', 'other', 'store'], 'the bare context and its store (single- or double-quoted subscript) are context names; HandlerContext<...> and a non-store sub-part are not');
      const scan = scanResolverSource(probe);
      assert.deepEqual(scan.callLines, [6]);
      assert.deepEqual(scan.remainingReads, [{ kind: 'handler', via: 'assertCwdInWorktree(store)', line: 4 }, { kind: 'handler', via: 'assertCwdInWorktree(dq)', line: 9 }], 'the non-local callee receiving the store (either quoting) is the only delegation; the generic local callees are not');
      assert.equal(scan.workspaceRooted, false);
      assert.equal(classificationOf(scan), 'reads ctx.root: via-handler(assertCwdInWorktree)');
      // The same invariant on the real audit: a delegation names a callee outside its file, never a function the file declares.
      const report = auditResolverCallSites(HANDLERS_DIR);
      for (const caller of report.callers) {
        const locals = localFunctionNames(readFileSync(join(HANDLERS_DIR, caller.file), 'utf-8'));
        const delegations = caller.remainingReads.filter((read) => read.kind === 'handler').map((read) => read.via.replace(/\(.*\)$/, '')).filter((via) => locals.has(via));
        assert.deepEqual(delegations, [], `${caller.file}: flagged via a function it declares itself`);
      }
    },
  },
  {
    name: 'adversarial: the flagged list is non-empty (this story does not migrate the callers; the printed list is the scope of draft migrate-resolvegitcwd-callers-to-workspace) and its count is printed',
    run: () => {
      const report = auditResolverCallSites(HANDLERS_DIR);
      const rendered = renderResolverAudit(report);
      assert.ok(report.flagged.length > 0, 'the flagged list must be non-empty: the story only migrated the four CHK-003 resolver implementations');
      assert.ok(report.flagged.every((caller) => !caller.workspaceRooted && caller.remainingReads.length > 0));
      const countLine = rendered.find((line) => line.startsWith('  flagged callers (reads ctx.root): '));
      assert.ok(countLine, 'the flagged count line is printed');
      assert.equal(countLine, `  flagged callers (reads ctx.root): ${report.flagged.length} of ${report.callers.length}`);
      assert.equal(rendered[0], 'resolveGitCwd call sites', 'the block heading');
      console.log(`flagged callers: ${report.flagged.length}`);
    },
  },
  {
    name: 'registration: test:single-owner-extraction is in root package.json scripts and test:serial-reference, in full-suite-runner RESOURCE_POLICY (entriesFromSerialReference accepts the real inventory), and in proof-or-stop.config.json validate.commands',
    run: () => {
      const suite = 'test:single-owner-extraction';
      const pkg = readRootPackageJson();
      assert.equal(pkg.scripts[suite], 'node packages/main/dist/tasks/single-owner-extraction-smoke.js', `root package.json scripts.${suite}`);
      const chain = pkg.scripts['test:serial-reference'] ?? '';
      assert.ok(chain.split(/\s*&&\s*/).includes(`npm run ${suite}`), `${suite} must be a member of test:serial-reference`);
      const runnerSource = readFileSync(join(MAIN_SRC, 'tasks', 'full-suite-runner.ts'), 'utf-8');
      assert.ok(new RegExp(`(repoRead|isolated)\\('${suite}'`).test(runnerSource), `${suite} must have a RESOURCE_POLICY row in full-suite-runner.ts`);
      const entries = entriesFromSerialReference([pkg.scripts['test:serial-reference-prefix'], chain].filter(Boolean).join(' && '), pkg.scripts);
      assert.ok(entries.some((entry) => entry.name === suite), 'the runner accepts the real inventory with the suite in it (bidirectional membership check)');
      const config = JSON.parse(readFileSync(join(REPO_ROOT, 'proof-or-stop.config.json'), 'utf-8')) as { validate: { commands: Array<{ command?: string; args?: string[] }> } };
      const entry = config.validate.commands.find((command) => Array.isArray(command.args) && command.args[0] === 'packages/main/dist/tasks/single-owner-extraction-smoke.js');
      assert.ok(entry, 'proof-or-stop.config.json validate.commands must list the smoke');
      assert.equal(entry!.command, 'node');
    },
  },
  {
    name: DEFAULT_STDOUT_BOUND_CASE_NAME,
    run: () => {
      // Projection = everything written so far, with the audit block as printed swapped for its default rendering,
      // plus exactly the lines still to come when every case passes. It is exact only if this case is the last one.
      const lastGroup = GROUPS[GROUPS.length - 1]!;
      assert.equal(lastGroup.cases[lastGroup.cases.length - 1]!.name, DEFAULT_STDOUT_BOUND_CASE_NAME, 'this case must stay the last case of the last group (add new cases before it): its projection covers exactly the lines printed after it');
      assert.ok(printedAuditChars > 0, 'the audit case printed the block before this case ran');
      const total = GROUPS.reduce((count, g) => count + g.cases.length, 0);
      const report = auditResolverCallSites(HANDLERS_DIR);
      const compact = renderResolverAudit(report, false);
      const compactChars = renderedChars(compact);
      const verboseChars = renderedChars(renderResolverAudit(report, true));
      const tail = `[PASS] ${DEFAULT_STDOUT_BOUND_CASE_NAME}\n${total}/${total} cases passed\n${MARKER}: PASS\n`;
      const base = capturedStdoutChars - printedAuditChars + compactChars + tail.length;
      const summaryLine = (projected: number): string => `default stdout projection: ${projected} chars (bound ${DEFAULT_STDOUT_BOUND_CHARS}; audit block ${compactChars} chars)`;
      // The summary line below is part of the output; its length depends only on the digit count of the projection.
      let projected = base + summaryLine(base).length + 1;
      projected = base + summaryLine(projected).length + 1;
      assert.ok(projected < DEFAULT_STDOUT_BOUND_CHARS, `default stdout is ${projected} chars, not under ${DEFAULT_STDOUT_BOUND_CHARS}: the audit block (${compactChars} chars by default) must stay compact -- one line per caller with a call-line column; the full rule and per-read detail only under SINGLE_OWNER_AUDIT_VERBOSE=1`);
      assert.ok(!compact.some((line) => /\bcalls L\d/.test(line) || line.includes('  -- ')), 'the default rendering carries no per-read detail (call lines are a compact column, not the verbose `calls` form)');
      assert.ok(verboseChars > compactChars, 'the verbose rendering is the one carrying the detail');
      console.log(summaryLine(projected));
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
