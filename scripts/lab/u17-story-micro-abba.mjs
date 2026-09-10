import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
const repo = resolve(process.argv[2] ?? process.cwd());
const outputParent = resolve(process.argv[3] ?? tmpdir());
mkdirSync(outputParent, { recursive: true });
const out = mkdtempSync(join(outputParent, 'u17-story-micro-'));
const { verifyBuildBinding } = await import(pathToFileURL(join(repo, 'scripts/full-suite-build-binding.mjs')));
const binding = verifyBuildBinding(repo);
const repositoryGit = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: 'pipe' }).trim();
const repositoryHead = repositoryGit('rev-parse', 'HEAD');
const baseline = repositoryGit('rev-parse', '--verify', '3f010a95b2^{commit}');
const root = join(out, 'fixture');
mkdirSync(root);
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: 'pipe' }).trim();
const commit = () => { git('add', '.'); git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'fixture'); };
const rows = [];
try {
  git('init', '-q'); git('checkout', '-qb', 'main');
  for (let i = 0; i < 50; i++) writeFileSync(join(root, `file-${i}.ts`), `export const value${i} = ${i};\n`);
  commit(); git('checkout', '-qb', 'story');
  for (let i = 0; i < 50; i++) writeFileSync(join(root, `file-${i}.ts`), `export const value${i} = ${i + 1};\n`);
  commit();
  const fixtureHead = git('rev-parse', 'HEAD');
  for (const mode of ['new', 'old', 'old', 'new']) {
    const start = performance.now();
    const raw = execFileSync(process.execPath, [
      '--import', fileURLToPath(new URL('./u17-story-baseline-loader.mjs', import.meta.url)),
      fileURLToPath(new URL('./u17-story-micro-child.mjs', import.meta.url)),
    ], { cwd: repo, env: { ...process.env, U17_REPO: repo, U17_FIXTURE: root, U17_MODE: mode, U17_BASELINE: baseline },
      encoding: 'utf8', timeout: 30_000, maxBuffer: 4 * 1024 * 1024 });
    const row = JSON.parse(raw);
    row.processWallMs = performance.now() - start;
    assert.equal(row.hashes.length, 20);
    assert.ok(row.hashes.every(hash => typeof hash === 'string' && hash === row.hashes[0]));
    if (rows.length) assert.deepEqual(row.hashes, rows[0].hashes);
    assert.equal(git('rev-parse', 'HEAD'), fixtureHead);
    rows.push(row);
    writeFileSync(join(out, `round-${rows.length - 1}.json`), JSON.stringify(row, null, 2));
    console.log(JSON.stringify(row));
  }
  assert.equal(repositoryGit('rev-parse', 'HEAD'), repositoryHead);
  assert.deepEqual(verifyBuildBinding(repo), binding);
  writeFileSync(join(out, 'results.json'), JSON.stringify({ repositoryHead, baseline, binding, fixtureHead, rows,
    timingScope: '20 public function calls after imports; processWallMs includes asymmetric historical TypeScript loading and is diagnostic only',
    comparisonScope: '50-file microfixture, actual current dist versus two historical modules; not original quorum or P95' }, null, 2));
  console.log(`PASS U17 story micro ABBA ${out}`);
} finally { rmSync(root, { recursive: true, force: true }); }
