#!/usr/bin/env node
// Lab framework-perf: the cross-process git read cache (core/git-read-cache.ts)
// must return exactly what git returns now. Every case below is a way a stale
// answer could leak into a decision; each must reach git (or return git's
// current bytes), while an unchanged repeat is answered without a child process.
import assert from 'node:assert/strict';
import { execFileSync as rawExecFileSync, spawnSync as rawSpawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const dist = resolve(here, '..', 'dist', 'core');
const modUrl = new URL(`file://${join(dist, 'git-read-cache.js')}`).href;
const witnessUrl = new URL(`file://${join(dist, 'git-ref-witness-memo.js')}`).href;
const results = [];
const check = (name, fn) => { try { fn(); results.push(`ok ${name}`); } catch (error) { results.push(`FAIL ${name}: ${error.message}`); } };

// --- child mode: run git reads through the installed cache and report -------
if (process.argv[2] === '--child') {
  const { installGitReadCache, gitSpawnCounters } = await import(modUrl);
  const { withFreshGitReads } = await import(witnessUrl);
  installGitReadCache();
  const { execFileSync, spawnSync } = await import('node:child_process');
  const spec = JSON.parse(process.argv[3]);
  // Warm-up: resolve the git var locations (system config etc.) so the counters measure only the calls below.
  try { execFileSync('git', ['rev-parse', '--git-dir'], { cwd: spec.calls[0].cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); } catch { /* not a repo */ }
  const before = gitSpawnCounters();
  const out = [];
  for (const call of spec.calls) {
    const run = () => {
      try {
        if (call.api === 'spawnSync') {
          const r = spawnSync('git', call.argv, { cwd: call.cwd, encoding: call.encoding, env: call.env ? { ...process.env, ...call.env } : undefined });
          return { status: r.status, stdout: Buffer.isBuffer(r.stdout) ? `buf:${r.stdout.toString('hex')}` : r.stdout, stderr: Buffer.isBuffer(r.stderr) ? `buf:${r.stderr.toString('hex')}` : r.stderr };
        }
        const v = execFileSync('git', call.argv, { cwd: call.cwd, encoding: call.encoding, stdio: ['ignore', 'pipe', 'pipe'], env: call.env ? { ...process.env, ...call.env } : undefined });
        return { stdout: Buffer.isBuffer(v) ? `buf:${v.toString('hex')}` : v };
      } catch (error) { return { threw: error.status ?? String(error) }; }
    };
    out.push(call.fresh ? withFreshGitReads(run) : run());
  }
  const after = gitSpawnCounters();
  process.stdout.write(JSON.stringify({ out, counters: Object.fromEntries(Object.keys(after).map(name => [name, after[name] - before[name]])) }));
  process.exit(0);
}

if (process.argv[2] === '--env-child') {
  const { envDerived } = await import(new URL(`file://${join(dist, 'process-env-version.js')}`).href);
  const { gitObservationKey } = await import(new URL(`file://${join(dist, 'git-tree-observation.js')}`).href);
  const seen = [];
  let derived = 0;
  const value = envDerived(() => { derived++; return process.env.POS_ENV_PROBE ?? null; });
  const key = () => gitObservationKey(['probe']);
  const k0 = key(); seen.push(value(), value());
  process.env.POS_ENV_PROBE = 'one'; seen.push(value()); const k1 = key();
  Object.assign(process.env, { POS_ENV_PROBE: 'two' }); seen.push(value());
  delete process.env.POS_ENV_PROBE; seen.push(value()); const k2 = key();
  const cloned = structuredClone(process.env).POS_ENV_PROBE === undefined;
  process.stdout.write(JSON.stringify({ seen, derived, keysDiffer: k0 !== k1 && k1 !== k2 && k0 !== k2, cloned }));
  process.exit(0);
}

const git = (cwd, ...args) => rawExecFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const child = (calls, env = {}) => {
  const r = rawSpawnSync(process.execPath, [fileURLToPath(import.meta.url), '--child', JSON.stringify({ calls })], { encoding: 'utf8', env: { ...process.env, ...env } });
  if (r.status !== 0) throw new Error(`child failed: ${r.stderr}`);
  return JSON.parse(r.stdout);
};

const root = realpathSync(mkdtempSync(join(tmpdir(), 'pos-git-read-cache-')));
const repo = join(root, 'repo');
try {
  rawExecFileSync('git', ['init', '-q', '-b', 'main', repo]);
  git(repo, 'config', 'user.email', 't@e'); git(repo, 'config', 'user.name', 't'); git(repo, 'config', 'commit.gpgsign', 'false');
  writeFileSync(join(repo, 'a.txt'), 'one\n'); git(repo, 'add', '.'); git(repo, 'commit', '-q', '-m', 'first');
  const first = git(repo, 'rev-parse', 'HEAD');
  const head = { argv: ['rev-parse', 'HEAD'], cwd: repo, encoding: 'utf8' };
  const subject = oid => ({ argv: ['show', '-s', '--format=%s', oid], cwd: repo, encoding: 'utf8' });

  check('a repeat in the same process is answered without a child process', () => {
    const r = child([head, head]);
    assert.equal(r.out[0].stdout.trim(), first);
    assert.deepEqual(r.out[1], r.out[0]);
    assert.equal(r.counters.gitSpawns, 1);
    assert.equal(r.counters.gitCacheHits, 1);
  });

  check('a later process reuses the answer (ref state and object reads)', () => {
    child([head, subject(first)]);
    const r = child([head, subject(first)]);
    assert.equal(r.out[0].stdout.trim(), first);
    assert.equal(r.out[1].stdout.trim(), 'first');
    assert.equal(r.counters.gitSpawns, 0);
    assert.equal(r.counters.gitCacheHits, 2);
  });

  check('a ref moved by another process is never answered from the cache', () => {
    child([head]);
    writeFileSync(join(repo, 'a.txt'), 'two\n'); git(repo, 'commit', '-qam', 'second');
    const second = git(repo, 'rev-parse', 'HEAD');
    const r = child([head, { argv: ['rev-parse', '--abbrev-ref', 'HEAD'], cwd: repo, encoding: 'utf8' }]);
    assert.equal(r.out[0].stdout.trim(), second);
    git(repo, 'update-ref', 'refs/heads/main', first);
    assert.equal(child([head]).out[0].stdout.trim(), first, 'moved back: the answer for the first state is current again');
    git(repo, 'update-ref', 'refs/heads/main', second);
    assert.equal(child([head]).out[0].stdout.trim(), second);
  });

  check('another worktree of the same repository gets its own answer', () => {
    const wt = join(root, 'wt');
    git(repo, 'worktree', 'add', '-q', '--detach', wt, first);
    const r = child([head, { ...head, cwd: wt }, { argv: ['worktree', 'list', '--porcelain'], cwd: repo, encoding: 'utf8' }]);
    assert.equal(r.out[0].stdout.trim(), git(repo, 'rev-parse', 'HEAD'));
    assert.equal(r.out[1].stdout.trim(), first);
    assert.ok(r.out[2].stdout.includes(wt), 'worktree list sees the new checkout');
    rmSync(wt, { recursive: true, force: true });
    const after = child([{ argv: ['worktree', 'list', '--porcelain'], cwd: repo, encoding: 'utf8' }]);
    assert.equal(after.out[0].stdout, rawExecFileSync('git', ['worktree', 'list', '--porcelain'], { cwd: repo, encoding: 'utf8' }), 'a vanished checkout is reported as git reports it');
    git(repo, 'worktree', 'prune');
  });

  check('a redirected git environment always runs git', () => {
    const other = join(root, 'other');
    rawExecFileSync('git', ['init', '-q', '-b', 'main', other]);
    git(other, 'config', 'user.email', 't@e'); git(other, 'config', 'user.name', 't');
    writeFileSync(join(other, 'b.txt'), 'b\n'); git(other, 'add', '.'); git(other, 'commit', '-q', '-m', 'other');
    child([head]);
    const r = child([{ ...head, env: { GIT_DIR: join(other, '.git') } }]);
    assert.equal(r.out[0].stdout.trim(), git(other, 'rev-parse', 'HEAD'));
    assert.equal(r.counters.gitCacheHits, 0);
  });

  check('a fresh-read scope (launch-time reread) always runs git', () => {
    child([head]);
    const r = child([{ ...head, fresh: true }]);
    assert.equal(r.counters.gitSpawns, 1);
    assert.equal(r.counters.gitCacheHits, 0);
  });

  check('a failing probe is never cached', () => {
    const missing = { argv: ['rev-parse', '--verify', '--quiet', 'refs/heads/nope'], cwd: repo, encoding: 'utf8' };
    const r = child([missing, missing]);
    assert.ok(r.out[0].threw !== undefined && r.out[1].threw !== undefined);
    assert.equal(r.counters.gitSpawns, 2);
    git(repo, 'branch', 'nope');
    assert.equal(child([missing]).out[0].stdout.trim(), git(repo, 'rev-parse', 'HEAD'));
    git(repo, 'branch', '-D', 'nope');
  });

  check('a replace ref changes what an object read returns: the cache follows git', () => {
    const second = git(repo, 'rev-parse', 'HEAD');
    child([subject(first)]);
    git(repo, 'replace', first, second);
    const r = child([subject(first)]);
    assert.equal(r.out[0].stdout.trim(), git(repo, 'show', '-s', '--format=%s', first));
    assert.equal(r.out[0].stdout.trim(), 'second');
    git(repo, 'replace', '-d', first);
    assert.equal(child([subject(first)]).out[0].stdout.trim(), 'first');
  });

  check('a hit has the same shape and encoding as a miss (Buffer, string, spawnSync)', () => {
    const calls = [{ ...head, encoding: undefined }, { ...head, api: 'spawnSync' }, { ...head, api: 'spawnSync', encoding: undefined }];
    const cold = child(calls, { PROOF_OR_STOP_GIT_READ_CACHE: '0' });
    child(calls);
    const warm = child(calls);
    assert.equal(warm.counters.gitCacheHits, 3);
    assert.deepEqual(warm.out, cold.out);
  });

  check('a corrupted cache line is ignored (git runs, right bytes)', () => {
    const dir = join(repo, '.git', 'info', 'proof-or-stop-cache', 'git-read-v1');
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      writeFileSync(path, readFileSync(path, 'utf8').split('\n').map(line => {
        if (!line) return line;
        const row = JSON.parse(line);
        row.o = Buffer.from('0000000000000000000000000000000000000000\n').toString('base64');
        return JSON.stringify(row);
      }).join('\n'));
    }
    const r = child([head, subject(first)]);
    assert.equal(r.out[0].stdout.trim(), git(repo, 'rev-parse', 'HEAD'));
    assert.equal(r.out[1].stdout.trim(), 'first');
    assert.equal(r.counters.gitCacheHits, 0);
  });

  check('layout-only rev-parse survives a ref move; a moved .git pointer does not', () => {
    const layout = { argv: ['rev-parse', '--path-format=absolute', '--git-common-dir'], cwd: repo, encoding: 'utf8' };
    child([layout]);
    writeFileSync(join(repo, 'a.txt'), 'three\n'); git(repo, 'commit', '-qam', 'third');
    const r = child([layout]);
    assert.equal(r.out[0].stdout.trim(), realpathSync(join(repo, '.git')));
    assert.equal(r.counters.gitSpawns, 0, 'a ref move does not touch the layout');
    const wt = join(root, 'wt-layout');
    git(repo, 'worktree', 'add', '-q', '--detach', wt, 'HEAD');
    const w = child([{ ...layout, cwd: wt }, { argv: ['rev-parse', '--git-dir'], cwd: wt, encoding: 'utf8' }]);
    assert.equal(w.out[0].stdout.trim(), realpathSync(join(repo, '.git')));
    assert.ok(w.out[1].stdout.trim().includes(join('.git', 'worktrees')), 'the linked worktree reports its own git dir');
    git(repo, 'worktree', 'remove', '--force', wt);
  });

  check('object-only reads (peel/verify, merge base, tree listing, cat-file) hit; a missing object never caches', () => {
    const top = git(repo, 'rev-parse', 'HEAD');
    const calls = [
      { argv: ['rev-parse', '--verify', '--end-of-options', `${first}^{commit}`], cwd: repo, encoding: 'utf8' },
      { argv: ['merge-base', first, top], cwd: repo, encoding: 'utf8' },
      { argv: ['ls-tree', '-r', '-z', top], cwd: repo, encoding: 'utf8' },
      { argv: ['cat-file', '-t', first], cwd: repo, encoding: 'utf8' },
    ];
    const cold = child(calls, { PROOF_OR_STOP_GIT_READ_CACHE: '0' });
    child(calls);
    writeFileSync(join(repo, 'a.txt'), 'four\n'); git(repo, 'commit', '-qam', 'fourth');
    const warm = child(calls);
    assert.deepEqual(warm.out, cold.out);
    assert.equal(warm.counters.gitSpawns, 0, 'object reads survive a ref move');
    const missing = { argv: ['rev-parse', '--verify', '--quiet', `${'0'.repeat(39)}1^{commit}`], cwd: repo, encoding: 'utf8' };
    const m = child([missing, missing]);
    assert.equal(m.counters.gitSpawns, 2);
  });

  check('a config edit reaches object reads (namespace includes config identity)', () => {
    const s = subject(first);
    child([s]);
    git(repo, 'config', 'i18n.logOutputEncoding', 'UTF-16');
    const r = child([s]);
    assert.equal(r.counters.gitSpawns, 1, 'config changed: git runs');
    assert.equal(r.out[0].stdout, rawExecFileSync('git', ['show', '-s', '--format=%s', first], { cwd: repo, encoding: 'utf8' }));
    git(repo, 'config', '--unset', 'i18n.logOutputEncoding');
  });

  check('named-ref reads follow exactly the refs they name (an unrelated ref move keeps them, a move of a named ref reaches git)', () => {
    const top = git(repo, 'rev-parse', 'HEAD');
    const calls = [
      { argv: ['merge-base', '--end-of-options', 'refs/heads/main', first], cwd: repo, encoding: 'utf8' },
      { argv: ['rev-parse', '--verify', '--end-of-options', 'HEAD^{object}'], cwd: repo, encoding: 'utf8' },
      { argv: ['ls-tree', '-r', '--name-only', 'HEAD', '--', 'a.txt'], cwd: repo, encoding: 'utf8' },
    ];
    child(calls);
    git(repo, 'update-ref', 'refs/proof-or-stop/unrelated', first);
    const kept = child(calls);
    assert.equal(kept.counters.gitSpawns, 0, 'an unrelated ref does not reach these reads');
    assert.equal(kept.out[1].stdout.trim(), top);
    writeFileSync(join(repo, 'a.txt'), 'five\n'); git(repo, 'commit', '-qam', 'fifth');
    const moved = child(calls, { PROOF_OR_STOP_GIT_READ_CACHE: '0' });
    const after = child(calls);
    assert.deepEqual(after.out, moved.out);
    assert.equal(after.out[1].stdout.trim(), git(repo, 'rev-parse', 'HEAD'));
    git(repo, 'pack-refs', '--all');
    const packed = child(calls);
    assert.deepEqual(packed.out, moved.out, 'packed refs resolve the same');
    git(repo, 'checkout', '-q', '--detach', first);
    assert.equal(child(calls).out[1].stdout.trim(), first, 'a detached HEAD is a new answer');
    git(repo, 'checkout', '-q', 'main');
  });

  check('-C <dir> is the same read as cwd <dir>', () => {
    const viaC = { argv: ['-C', repo, 'rev-parse', 'HEAD'], cwd: root, encoding: 'utf8' };
    const r = child([head, viaC]);
    assert.equal(r.out[1].stdout, r.out[0].stdout);
    assert.equal(r.counters.gitCacheHits, 1 + (r.counters.gitSpawns === 0 ? 1 : 0));
  });

  check('a quiet "no" (is-ancestor, symbolic-ref -q) is replayed with git\'s exact error; a later "yes" reaches git', () => {
    const top = git(repo, 'rev-parse', 'HEAD');
    const no = { argv: ['merge-base', '--is-ancestor', top, first], cwd: repo, encoding: 'utf8' };
    const sym = { argv: ['symbolic-ref', '-q', 'refs/remotes/origin/HEAD'], cwd: repo, encoding: 'utf8' };
    const cold = child([no, sym, { ...no, api: 'spawnSync' }], { PROOF_OR_STOP_GIT_READ_CACHE: '0' });
    child([no, sym]);
    const warm = child([no, sym, { ...no, api: 'spawnSync' }]);
    assert.equal(warm.counters.gitSpawns, 0);
    assert.deepEqual(warm.out, cold.out);
    assert.equal(warm.out[0].threw, 1);
    git(repo, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/heads/main');
    assert.equal(child([sym]).out[0].stdout.trim(), 'refs/heads/main');
    git(repo, 'symbolic-ref', '--delete', 'refs/remotes/origin/HEAD');
    assert.ok(child([sym]).out[0].threw !== undefined);
  });

  check('for-each-ref over a literal prefix follows refs under the prefix only', () => {
    const list = { argv: ['for-each-ref', '--format=%(refname) %(objectname)', 'refs/proof-or-stop/checkpoints'], cwd: repo, encoding: 'utf8' };
    git(repo, 'update-ref', 'refs/proof-or-stop/checkpoints/a', first);
    child([list]);
    git(repo, 'update-ref', 'refs/proof-or-stop/elsewhere', first);
    const kept = child([list]);
    assert.equal(kept.counters.gitSpawns, 0);
    git(repo, 'update-ref', 'refs/proof-or-stop/checkpoints/b', first);
    const grown = child([list]);
    assert.equal(grown.out[0].stdout, rawExecFileSync('git', list.argv, { cwd: repo, encoding: 'utf8' }));
    assert.match(grown.out[0].stdout, /checkpoints\/b/);
    git(repo, 'pack-refs', '--all');
    git(repo, 'update-ref', '-d', 'refs/proof-or-stop/checkpoints/a');
    assert.equal(child([list]).out[0].stdout, rawExecFileSync('git', list.argv, { cwd: repo, encoding: 'utf8' }), 'a packed ref deleted');
  });

  check('setup reads: config --list with an include directive always runs git', () => {
    const list = { argv: ['config', '--null', '--list'], cwd: repo, encoding: 'utf8' };
    const vars = { argv: ['var', 'GIT_CONFIG_GLOBAL'], cwd: repo, encoding: 'utf8' };
    child([list, vars]);
    const warm = child([list, vars]);
    assert.equal(warm.counters.gitSpawns, 0);
    writeFileSync(join(root, 'extra.cfg'), '[proofcheck]\n\tvalue = one\n');
    git(repo, 'config', 'include.path', join(root, 'extra.cfg'));
    child([list]);
    writeFileSync(join(root, 'extra.cfg'), '[proofcheck]\n\tvalue = two\n');
    const r = child([list]);
    assert.equal(r.counters.gitSpawns, 1);
    assert.match(r.out[0].stdout, /proofcheck\.value\ntwo/);
    git(repo, 'config', '--unset', 'include.path');
  });

  check('revision diffs with rename detection: reused while the attributes of their paths are unchanged', () => {
    const before = git(repo, 'rev-parse', 'HEAD');
    writeFileSync(join(repo, 'moved-src.txt'), 'line one\nline two\nline three\nline four\n'); git(repo, 'add', '.'); git(repo, 'commit', '-q', '-m', 'add src');
    const base = git(repo, 'rev-parse', 'HEAD');
    git(repo, 'mv', 'moved-src.txt', 'moved-dst.txt'); writeFileSync(join(repo, 'moved-dst.txt'), 'line one\nline two\nline three\nline 4\n');
    git(repo, 'add', '.'); git(repo, 'commit', '-q', '-m', 'rename');
    const tip = git(repo, 'rev-parse', 'HEAD');
    const calls = [
      { argv: ['diff', '--name-status', '-M', '-z', `${base}..${tip}`], cwd: repo, encoding: 'utf8' },
      { argv: ['diff', '--name-status', '--find-renames', `refs/heads/main~1...HEAD`].map(arg => arg.replace('refs/heads/main~1', base)), cwd: repo, encoding: 'utf8' },
      { argv: ['diff', '--find-renames', '--find-copies', '--unified=20', '--full-index', `${base}...HEAD`], cwd: repo, encoding: 'utf8' },
    ];
    const cold = child(calls, { PROOF_OR_STOP_GIT_READ_CACHE: '0' });
    assert.match(cold.out[0].stdout, /R\d+\0moved-src\.txt\0moved-dst\.txt/);
    child(calls);
    const warm = child(calls);
    assert.deepEqual(warm.out, cold.out);
    assert.equal(warm.counters.gitSpawns, 0, 'no attribute source on these paths: every diff is reused');
    // An attribute on one of the output paths reaches git again (and the patch is never reused once any attribute source exists).
    writeFileSync(join(repo, '.gitattributes'), 'moved-*.txt -diff\n');
    const attributed = child(calls);
    assert.equal(attributed.counters.gitSpawns, 3, 'every diff reaches git once its paths carry an attribute');
    assert.deepEqual(attributed.out, child(calls, { PROOF_OR_STOP_GIT_READ_CACHE: '0' }).out);
    const again = child(calls);
    assert.equal(again.counters.gitSpawns, 1, 'name-status forms are reused under the same attributes; the patch form is not');
    // A .gitattributes tracked in the index (even with the checkout file deleted) is never witnessed: always git.
    git(repo, 'add', '.gitattributes'); git(repo, 'commit', '-q', '-m', 'attrs');
    rmSync(join(repo, '.gitattributes'));
    const indexed = child([calls[0], calls[0]]);
    assert.equal(indexed.counters.gitSpawns, 2);
    git(repo, 'checkout', '-q', '--', '.gitattributes'); git(repo, 'rm', '-q', '.gitattributes'); git(repo, 'commit', '-q', '-m', 'no attrs');
    // A range over a ref follows that ref.
    const range = { argv: ['diff', '--name-status', '--find-renames', `${before}...HEAD`], cwd: repo, encoding: 'utf8' };
    child([range]);
    writeFileSync(join(repo, 'later.txt'), 'x\n'); git(repo, 'add', '.'); git(repo, 'commit', '-q', '-m', 'later');
    const moved = child([range]);
    assert.match(moved.out[0].stdout, /later\.txt/);
  });

  check('environment keys follow every process.env write (set, Object.assign, delete); process.env stays a plain env', () => {
    const r = rawSpawnSync(process.execPath, [fileURLToPath(import.meta.url), '--env-child'], { encoding: 'utf8', env: { ...process.env, POS_ENV_PROBE: '' } });
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.deepEqual(out.seen, ['', '', 'one', 'two', null]);
    assert.equal(out.derived, 4, 'rebuilt once per change, not per call');
    assert.equal(out.keysDiffer, true);
    assert.equal(out.cloned, true, 'structuredClone(process.env) works');
  });

  check('a revision that also names a file is ambiguous to git: the cache never hides it', () => {
    const plain = { argv: ['rev-list', '-1', 'HEAD'], cwd: repo, encoding: 'utf8' };
    const warm = child([plain, plain]);
    assert.equal(warm.counters.gitCacheHits >= 1, true, 'cached before the file exists');
    writeFileSync(join(repo, 'HEAD'), 'not a ref\n');
    const r = child([plain]);
    assert.equal(r.counters.gitCacheHits, 0);
    assert.deepEqual(r.out, child([plain], { PROOF_OR_STOP_GIT_READ_CACHE: '0' }).out);
    assert.ok(r.out[0].threw !== undefined, 'git refuses the ambiguous argument');
    rmSync(join(repo, 'HEAD'));
  });

  check('a call with its own HOME (another global config) always runs git', () => {
    const own = { ...head, env: { HOME: join(root, 'other-home') } };
    child([head]);
    const r = child([own, own]);
    assert.equal(r.counters.gitSpawns, 2);
  });

  // Review findings (lab framework-perf correctness review): each must reach git or return git's current bytes.
  check('review 1: a utf8 caller never hands decoded bytes to a Buffer caller', () => {
    const blob = rawExecFileSync('git', ['hash-object', '-w', '--stdin'], { cwd: repo, input: Buffer.from([0x63, 0xe9, 0xff, 0xfe, 0x0a]), encoding: 'utf8' }).trim();
    const asText = { argv: ['cat-file', 'blob', blob], cwd: repo, encoding: 'utf8' };
    const asBytes = { argv: ['cat-file', 'blob', blob], cwd: repo, encoding: undefined };
    child([asText]);
    const r = child([asBytes]);
    assert.equal(r.out[0].stdout, 'buf:63e9fffe0a');
  });

  check('review 2: a pruned loose object is never reported from the cache', () => {
    const blob = rawExecFileSync('git', ['hash-object', '-w', '--stdin'], { cwd: repo, input: 'prunable\n', encoding: 'utf8' }).trim();
    const calls = [{ argv: ['cat-file', '-p', blob], cwd: repo, encoding: 'utf8' }, { argv: ['rev-parse', '--verify', '--quiet', `${blob}^{blob}`], cwd: repo, encoding: 'utf8' }];
    child(calls); child(calls);
    git(repo, 'prune', '--expire=now');
    const r = child(calls);
    assert.ok(r.out[0].threw !== undefined && r.out[1].threw !== undefined, JSON.stringify(r.out));
  });

  check('review 3: a symbolic ref under a for-each-ref prefix follows its target', () => {
    git(repo, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
    git(repo, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');
    const list = { argv: ['for-each-ref', '--format=%(refname) %(objectname)', 'refs/remotes/origin/HEAD'], cwd: repo, encoding: 'utf8' };
    child([list]); child([list]);
    git(repo, 'update-ref', 'refs/remotes/origin/main', 'HEAD~1');
    assert.equal(child([list]).out[0].stdout, rawExecFileSync('git', list.argv, { cwd: repo, encoding: 'utf8' }));
    git(repo, 'symbolic-ref', '--delete', 'refs/remotes/origin/HEAD'); git(repo, 'update-ref', '-d', 'refs/remotes/origin/main');
  });

  check('review 4-6: decoration, notes, clock and abbreviation dependent output always runs git', () => {
    const calls = [
      { argv: ['rev-list', '--simplify-by-decoration', 'refs/heads/main'], cwd: repo, encoding: 'utf8' },
      { argv: ['show', '-s', '--format=%H %N', 'refs/heads/main'], cwd: repo, encoding: 'utf8' },
      { argv: ['show', '-s', '--format=%ah', 'refs/heads/main'], cwd: repo, encoding: 'utf8' },
      { argv: ['show', '-s', '--format=%h', 'refs/heads/main'], cwd: repo, encoding: 'utf8' },
      { argv: ['log', '-1', '--format=%h', '--abbrev=4', 'HEAD'], cwd: repo, encoding: 'utf8' },
    ];
    child(calls);
    const r = child(calls);
    assert.equal(r.counters.gitSpawns, calls.length, JSON.stringify(r.counters));
  });

  check('neutral-64: rev-parse --abbrev-ref HEAD is a ref-name read: cached while the ref state is unchanged, fresh after a tag makes the name ambiguous or HEAD moves; --abbrev=N stays refused', () => {
    const call = { argv: ['rev-parse', '--abbrev-ref', 'HEAD'], cwd: repo, encoding: 'utf8' };
    const truth = () => rawExecFileSync('git', call.argv, { cwd: repo, encoding: 'utf8' });
    child([call]);
    const warm = child([call]);
    assert.equal(warm.counters.gitSpawns, 0, JSON.stringify(warm.counters));
    assert.equal(warm.out[0].stdout, truth());
    const branch = truth().trim();
    git(repo, 'tag', branch);
    try {
      const ambiguous = child([call]);
      assert.equal(ambiguous.out[0].stdout, truth(), 'a tag with the branch name changes what strict mode prints; the answer is read fresh');
      assert.notEqual(ambiguous.out[0].stdout.trim(), branch);
    } finally { git(repo, 'tag', '-d', branch); }
    git(repo, 'checkout', '-q', '-b', 'neutral64-side');
    try { assert.equal(child([call]).out[0].stdout.trim(), 'neutral64-side'); } finally { git(repo, 'checkout', '-q', branch); git(repo, 'branch', '-D', 'neutral64-side'); }
    const volatile = { argv: ['rev-parse', '--abbrev=4', 'HEAD'], cwd: repo, encoding: 'utf8' };
    child([volatile]);
    assert.equal(child([volatile]).counters.gitSpawns, 1, 'abbreviated object ids depend on the object count: always git');
  });

  check('review 7: a config include refuses the cache', () => {
    writeFileSync(join(root, 'inc.cfg'), '[core]\n\tabbrev = 8\n');
    git(repo, 'config', 'include.path', join(root, 'inc.cfg'));
    const s = subject(first);
    const r = child([s, s]);
    assert.equal(r.counters.gitSpawns, 2);
    git(repo, 'config', '--remove-section', 'include');
  });

  check('review 8: rename-detecting --name-only (a rename prints only its destination) always runs git', () => {
    const top = git(repo, 'rev-parse', 'HEAD');
    const names = { argv: ['diff', '-M', '--name-only', `${first}..${top}`], cwd: repo, encoding: 'utf8' };
    const r = child([names, names]);
    assert.equal(r.counters.gitSpawns, 2);
  });

  check('review 11: a caller that shows stderr is never served an answer whose stderr was not captured', () => {
    const quiet = { argv: ['rev-parse', '--verify', '--end-of-options', 'HEAD^{object}'], cwd: repo, encoding: 'utf8' };
    child([quiet]);
    const forwarding = rawSpawnSync(process.execPath, ['-e', `
      const c = await import(${JSON.stringify(modUrl)}); c.installGitReadCache();
      const { execFileSync } = await import('node:child_process');
      execFileSync('git', ['rev-parse', '--verify', '--end-of-options', 'HEAD^{object}'], { cwd: ${JSON.stringify(repo)}, encoding: 'utf8' });
      process.stdout.write(JSON.stringify(c.gitSpawnCounters()));`], { encoding: 'utf8', input: '' });
    const counters = JSON.parse(forwarding.stdout || '{}');
    assert.equal(counters.gitSpawns, 1, forwarding.stderr);
  });

  check('PROOF_OR_STOP_GIT_READ_CACHE=0 turns the cache off', () => {
    const r = child([head, head], { PROOF_OR_STOP_GIT_READ_CACHE: '0' });
    assert.equal(r.counters.gitSpawns, 2);
    assert.equal(r.counters.gitCacheHits, 0);
  });

  check('index and working-tree reads always run git', () => {
    const status = { argv: ['status', '--porcelain'], cwd: repo, encoding: 'utf8' };
    const r = child([status, status]);
    assert.equal(r.counters.gitSpawns, 2);
    writeFileSync(join(repo, 'new.txt'), 'x\n');
    assert.ok(child([status]).out[0].stdout.includes('new.txt'));
  });
} finally {
  if (process.env.GIT_READ_CACHE_TEST_KEEP) console.log(`kept ${root}`); else rmSync(root, { recursive: true, force: true });
}
for (const line of results) console.log(line);
const failed = results.filter(line => line.startsWith('FAIL'));
if (failed.length) { console.log(`git-read-cache.test: FAIL (${failed.length}/${results.length})`); process.exit(1); }
console.log(`git-read-cache.test: PASS (${results.length} cases)`);
