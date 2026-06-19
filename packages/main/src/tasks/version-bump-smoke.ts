/**
 * Smoke: auto patch-version bump on DONE merge (B-aa8a).
 *
 * Hermetic — every case runs against a fresh temp fixture dir (os.tmpdir) holding copies
 * of the three version sync points, so the real repo version files are never touched.
 *
 * Proves: nextPatch is patch-only; applyPatchBump syncs all 3 points to the same new
 * patch and verifies the result; drift across the 3 points fails loud; the bump gate
 * (shouldBuildDoneMainPackageForChangedPaths) fires on material code but NOT on
 * metadata-only changes; bumpVersionOnDoneMerge skips cleanly when not qualifying and
 * commits when it does; and the bump is idempotent (exactly +1 per call).
 *
 * Run: node packages/main/dist/tasks/version-bump-smoke.js
 */

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseSemver,
  nextPatch,
  readSyncedVersion,
  applyPatchBump,
  bumpVersionOnDoneMerge,
  VERSION_BUMP_SKIPPED_LINE,
  VERSION_SYNC_FILES,
} from '../core/version-bump.js';
import {
  shouldBuildDoneMainPackageForChangedPaths,
  isDoneMainRuntimeBuildInput,
} from '../handlers/done-effects.js';

let passed = 0;
function check(name: string, cond: boolean): void {
  if (!cond) throw new Error(`FAIL: ${name}`);
  passed += 1;
}
function throws(name: string, fn: () => unknown): void {
  let threw = false;
  try { fn(); } catch { threw = true; }
  check(name, threw);
}

/** Build a fresh temp fixture root with the 3 sync points at `version` (or per-file overrides). */
function makeFixture(version: string, over?: { root?: string; main?: string; brand?: string }): string {
  const dir = mkdtempSync(join(tmpdir(), 'version-bump-smoke-'));
  mkdirSync(join(dir, 'packages/main/src/core'), { recursive: true });
  writeFileSync(join(dir, VERSION_SYNC_FILES.rootPackageJson), `{\n  "name": "lattice",\n  "version": "${over?.root ?? version}",\n  "description": ""\n}\n`);
  writeFileSync(join(dir, VERSION_SYNC_FILES.mainPackageJson), `{\n  "name": "@lattice-agent/core",\n  "version": "${over?.main ?? version}",\n  "type": "module"\n}\n`);
  writeFileSync(join(dir, VERSION_SYNC_FILES.brand), `import { basename } from 'path';\n\nexport const LATTICE_CLI_VERSION = '${over?.brand ?? version}' as const;\nexport const LATTICE_PRODUCT_NAME = 'Lattice CLI' as const;\nvoid basename;\n`);
  return dir;
}

const cleanup: string[] = [];
function fixture(version: string, over?: { root?: string; main?: string; brand?: string }): string {
  const d = makeFixture(version, over);
  cleanup.push(d);
  return d;
}

void (async () => {
  try {
    // 1. nextPatch is patch-only; parseSemver rejects malformed.
    check('nextPatch 0.3.9 -> 0.3.10', nextPatch('0.3.9') === '0.3.10');
    check('nextPatch 1.2.0 -> 1.2.1 (minor/major untouched)', nextPatch('1.2.0') === '1.2.1');
    check('nextPatch 0.0.0 -> 0.0.1', nextPatch('0.0.0') === '0.0.1');
    throws('parseSemver rejects malformed "1.2"', () => parseSemver('1.2'));
    throws('parseSemver rejects pre-release "1.2.3-rc1"', () => parseSemver('1.2.3-rc1'));

    // 2. applyPatchBump syncs all 3 points to the same new patch and verifies.
    const f2 = fixture('0.9.9');
    const r2 = applyPatchBump(f2);
    check('applyPatchBump from=0.9.9', r2.from === '0.9.9');
    check('applyPatchBump to=0.9.10', r2.to === '0.9.10');
    check('applyPatchBump reports 3 files', r2.files.length === 3);
    check('all 3 sync points now read 0.9.10', readSyncedVersion(f2) === '0.9.10');
    check('root package.json bumped', readFileSync(join(f2, VERSION_SYNC_FILES.rootPackageJson), 'utf-8').includes('"version": "0.9.10"'));
    check('main package.json bumped', readFileSync(join(f2, VERSION_SYNC_FILES.mainPackageJson), 'utf-8').includes('"version": "0.9.10"'));
    check('lattice-brand bumped', readFileSync(join(f2, VERSION_SYNC_FILES.brand), 'utf-8').includes("LATTICE_CLI_VERSION = '0.9.10'"));

    // 3. Drift across the 3 points fails loud (no silent pick).
    const f3 = fixture('0.9.9', { main: '0.9.8' });
    throws('readSyncedVersion throws on drift', () => readSyncedVersion(f3));
    throws('applyPatchBump throws on drift', () => applyPatchBump(f3));

    // 4. The bump gate matches material code, skips metadata-only.
    check('gate: packages/main/src file -> bump', shouldBuildDoneMainPackageForChangedPaths(['packages/main/src/core/x.ts']) === true);
    check('gate: root package.json -> bump', shouldBuildDoneMainPackageForChangedPaths(['package.json']) === true);
    check('gate: .lattice metadata only -> NO bump', shouldBuildDoneMainPackageForChangedPaths(['.lattice/story/actives/B-x/index.json']) === false);
    check('gate: mixed (.lattice + src) -> bump', shouldBuildDoneMainPackageForChangedPaths(['.lattice/story/actives/B-x/index.json', 'packages/main/src/core/x.ts']) === true);
    check('isDoneMainRuntimeBuildInput: brand src file', isDoneMainRuntimeBuildInput('packages/main/src/core/lattice-brand.ts') === true);
    check('isDoneMainRuntimeBuildInput: docs file -> false', isDoneMainRuntimeBuildInput('docs/readme.md') === false);

    // 5. bumpVersionOnDoneMerge SKIPS cleanly when not qualifying (no FS change, no git).
    const f5 = fixture('0.9.9');
    let f5GitCalls = 0;
    const skipLine = bumpVersionOnDoneMerge({ mainMergeRoot: f5, shouldBump: false, runGit: () => { f5GitCalls += 1; return ''; } });
    check('skip returns the skip line', skipLine === VERSION_BUMP_SKIPPED_LINE);
    check('skip made no git calls', f5GitCalls === 0);
    check('skip left the version unchanged', readSyncedVersion(f5) === '0.9.9');

    // 6. bumpVersionOnDoneMerge COMMITS when qualifying: files bumped + git add + chore:bump commit.
    const f6 = fixture('0.9.9');
    const gitCalls: Array<{ args: string[]; cwd: string }> = [];
    const line6 = bumpVersionOnDoneMerge({ mainMergeRoot: f6, shouldBump: true, runGit: (args, cwd) => { gitCalls.push({ args, cwd }); return ''; } });
    check('bump line reports 0.9.9 -> 0.9.10', line6.includes('0.9.9') && line6.includes('0.9.10'));
    check('bump wrote the new version', readSyncedVersion(f6) === '0.9.10');
    check('git add was issued', gitCalls.some((c) => c.args[0] === 'add' && c.args.includes(VERSION_SYNC_FILES.brand)));
    check('chore:bump commit was issued', gitCalls.some((c) => c.args.includes('commit') && c.args.some((a) => a === 'chore: bump lattice cli to 0.9.10')));
    check('git ran in the main merge root', gitCalls.every((c) => c.cwd === f6));

    // 7. Idempotent: each applyPatchBump call increments by exactly one (no accumulation).
    const f7 = fixture('0.9.9');
    check('first bump -> 0.9.10', applyPatchBump(f7).to === '0.9.10');
    check('second bump -> 0.9.11', applyPatchBump(f7).to === '0.9.11');
    check('two bumps land on 0.9.11', readSyncedVersion(f7) === '0.9.11');

    console.log(`version-bump smoke passed: ${passed} assertions`);
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exitCode = 1;
  } finally {
    for (const d of cleanup) {
      try { rmSync(d, { recursive: true, force: true }); } catch { /* best-effort temp cleanup */ }
    }
  }
})();
