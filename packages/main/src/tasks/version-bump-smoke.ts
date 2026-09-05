/**
 * Smoke: auto patch-version bump on DONE merge (B-aa8a).
 *
 * Hermetic — every case runs against a fresh temp fixture dir (os.tmpdir) holding copies
 * of the version sync points, so the real repo version files are never touched.
 *
 * Proves: nextPatch is patch-only; applyPatchBump syncs all package/lockfile/brand
 * points to the same new patch and verifies the result; drift across any sync point
 * fails loud; the bump gate
 * (shouldBuildDoneMainPackageForChangedPaths) fires on watched CLI/runtime or bounded
 * capability contract/proof inputs but NOT on metadata-only, arbitrary-doc, or offline
 * experiment-harness changes; bumpVersionOnDoneMerge skips cleanly when not qualifying
 * and commits when it does; and the bump is idempotent
 * (exactly +1 per call).
 *
 * Run: node packages/main/dist/tasks/version-bump-smoke.js
 */

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync } from 'node:fs';
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

type VersionOverrides = {
  root?: string;
  rootLock?: string;
  rootLockPackage?: string;
  rootLockMainPackage?: string;
  main?: string;
  mainLock?: string;
  mainLockPackage?: string;
  brand?: string;
};

/** Build a fresh temp fixture root with the sync files at `version` (or per-entry overrides). */
function makeFixture(version: string, over?: VersionOverrides): string {
  const dir = mkdtempSync(join(tmpdir(), 'version-bump-smoke-'));
  mkdirSync(join(dir, 'packages/main/src/core'), { recursive: true });
  writeFileSync(join(dir, VERSION_SYNC_FILES.rootPackageJson), `{\n  "name": "proof-or-stop",\n  "version": "${over?.root ?? version}",\n  "description": ""\n}\n`);
  writeFileSync(join(dir, VERSION_SYNC_FILES.rootPackageLock), JSON.stringify({
    name: 'proof-or-stop',
    version: over?.rootLock ?? version,
    lockfileVersion: 3,
    packages: {
      '': { name: 'proof-or-stop', version: over?.rootLockPackage ?? over?.rootLock ?? version },
      'packages/main': { name: '@proof-or-stop/core', version: over?.rootLockMainPackage ?? over?.rootLock ?? version },
    },
  }, null, 2) + '\n');
  writeFileSync(join(dir, VERSION_SYNC_FILES.mainPackageJson), `{\n  "name": "@proof-or-stop/core",\n  "version": "${over?.main ?? version}",\n  "type": "module"\n}\n`);
  writeFileSync(join(dir, VERSION_SYNC_FILES.mainPackageLock), JSON.stringify({
    name: '@proof-or-stop/core',
    version: over?.mainLock ?? version,
    lockfileVersion: 3,
    packages: {
      '': { name: '@proof-or-stop/core', version: over?.mainLockPackage ?? over?.mainLock ?? version },
    },
  }, null, 2) + '\n');
  writeFileSync(join(dir, VERSION_SYNC_FILES.brand), `import { basename } from 'path';\n\nexport const PROOF_OR_STOP_CLI_VERSION = '${over?.brand ?? version}' as const;\nexport const PROOF_OR_STOP_PRODUCT_NAME = 'Proof-or-Stop' as const;\nvoid basename;\n`);
  return dir;
}

const cleanup: string[] = [];
function fixture(version: string, over?: VersionOverrides): string {
  const d = makeFixture(version, over);
  cleanup.push(d);
  return d;
}

function readJson(path: string): any {
  return JSON.parse(readFileSync(path, 'utf-8'));
}

void (async () => {
  try {
    // 1. nextPatch is patch-only; parseSemver rejects malformed.
    check('nextPatch 0.3.9 -> 0.3.10', nextPatch('0.3.9') === '0.3.10');
    check('nextPatch 1.2.0 -> 1.2.1 (minor/major untouched)', nextPatch('1.2.0') === '1.2.1');
    check('nextPatch 0.0.0 -> 0.0.1', nextPatch('0.0.0') === '0.0.1');
    throws('parseSemver rejects malformed "1.2"', () => parseSemver('1.2'));
    throws('parseSemver rejects pre-release "1.2.3-rc1"', () => parseSemver('1.2.3-rc1'));

    // 2. applyPatchBump syncs all package, lockfile, and brand points to the same new patch and verifies.
    const f2 = fixture('0.9.9');
    const r2 = applyPatchBump(f2);
    check('applyPatchBump from=0.9.9', r2.from === '0.9.9');
    check('applyPatchBump to=0.9.10', r2.to === '0.9.10');
    check('applyPatchBump reports 5 files', r2.files.length === 5);
    check('all sync points now read 0.9.10', readSyncedVersion(f2) === '0.9.10');
    check('root package.json bumped', readFileSync(join(f2, VERSION_SYNC_FILES.rootPackageJson), 'utf-8').includes('"version": "0.9.10"'));
    const f2RootLock = readJson(join(f2, VERSION_SYNC_FILES.rootPackageLock));
    check('root package-lock top-level bumped', f2RootLock.version === '0.9.10');
    check('root package-lock root package entry bumped', f2RootLock.packages[''].version === '0.9.10');
    check('root package-lock packages/main entry bumped when present', f2RootLock.packages['packages/main'].version === '0.9.10');
    check('main package.json bumped', readFileSync(join(f2, VERSION_SYNC_FILES.mainPackageJson), 'utf-8').includes('"version": "0.9.10"'));
    const f2MainLock = readJson(join(f2, VERSION_SYNC_FILES.mainPackageLock));
    check('packages/main package-lock top-level bumped', f2MainLock.version === '0.9.10');
    check('packages/main package-lock root package entry bumped', f2MainLock.packages[''].version === '0.9.10');
    check('proof-or-stop-brand bumped', readFileSync(join(f2, VERSION_SYNC_FILES.brand), 'utf-8').includes("PROOF_OR_STOP_CLI_VERSION = '0.9.10'"));

    // 3. Drift across the sync points fails loud (no silent pick) and NAMES each value.
    const f3 = fixture('0.9.9', { main: '0.9.8' });
    throws('readSyncedVersion throws on drift', () => readSyncedVersion(f3));
    throws('applyPatchBump throws on drift', () => applyPatchBump(f3));
    let driftMsg = '';
    try { readSyncedVersion(f3); } catch (e) { driftMsg = e instanceof Error ? e.message : String(e); }
    check('drift error names each sync point value', driftMsg.includes('root=0.9.9') && driftMsg.includes('packages/main=0.9.8') && driftMsg.includes('proof-or-stop-brand=0.9.9'));
    const f3lock = fixture('0.9.9', { rootLock: '0.9.8' });
    throws('root package-lock top-level drift -> readSyncedVersion throws', () => readSyncedVersion(f3lock));
    let lockDriftMsg = '';
    try { readSyncedVersion(f3lock); } catch (e) { lockDriftMsg = e instanceof Error ? e.message : String(e); }
    check('lockfile drift error names root lockfile value', lockDriftMsg.includes('root lockfile=0.9.8'));
    const f3lockEntry = fixture('0.9.9', { mainLockPackage: '0.9.8' });
    throws('packages/main package-lock package entry drift -> applyPatchBump throws', () => applyPatchBump(f3lockEntry));

    // 3b. Root package identity must stay internally consistent while the old
    //     root name remains readable for pre-migration checkouts.
    const f3identity = fixture('0.9.9');
    const identityLockPath = join(f3identity, VERSION_SYNC_FILES.rootPackageLock);
    const identityLock = readJson(identityLockPath);
    identityLock.packages[''].name = 'lattice';
    writeFileSync(identityLockPath, JSON.stringify(identityLock, null, 2) + '\n');
    throws('root package/lock identity drift -> readSyncedVersion throws', () => readSyncedVersion(f3identity));
    const f3legacy = fixture('0.9.9');
    const legacyPackagePath = join(f3legacy, VERSION_SYNC_FILES.rootPackageJson);
    const legacyPackage = readJson(legacyPackagePath);
    legacyPackage.name = 'lattice';
    writeFileSync(legacyPackagePath, JSON.stringify(legacyPackage, null, 2) + '\n');
    const legacyLockPath = join(f3legacy, VERSION_SYNC_FILES.rootPackageLock);
    const legacyLock = readJson(legacyLockPath);
    legacyLock.name = 'lattice';
    legacyLock.packages[''].name = 'lattice';
    writeFileSync(legacyLockPath, JSON.stringify(legacyLock, null, 2) + '\n');
    check('legacy root package identity remains readable', readSyncedVersion(f3legacy) === '0.9.9');

    // 4. The bump gate matches watched CLI/runtime inputs, skips metadata-only and
    //    offline experiment harnesses. It also watches bounded CLI capability
    //    contract/proof inputs without turning all docs into bump inputs.
    check('gate: packages/main/src file -> bump', shouldBuildDoneMainPackageForChangedPaths(['packages/main/src/core/x.ts']) === true);
    check('gate: root package.json -> bump', shouldBuildDoneMainPackageForChangedPaths(['package.json']) === true);
    check('gate: docs/CLI.md capability contract -> bump', shouldBuildDoneMainPackageForChangedPaths(['docs/CLI.md']) === true);
    check('gate: packages/main/tests proof regression -> bump', shouldBuildDoneMainPackageForChangedPaths(['packages/main/tests/milestone-status.test.mjs']) === true);
    check('gate: .proof-or-stop metadata only -> NO bump', shouldBuildDoneMainPackageForChangedPaths(['.proof-or-stop/story/actives/B-x/index.json']) === false);
    check('gate: requirements decision doc -> NO bump', shouldBuildDoneMainPackageForChangedPaths(['docs/requirements/decisions/story-lifecycle.md']) === false);
    check('gate: experiments harness -> NO bump', shouldBuildDoneMainPackageForChangedPaths(['experiments/tier-c-proof/sum.mjs']) === false);
    check('gate: mixed (.proof-or-stop + src) -> bump', shouldBuildDoneMainPackageForChangedPaths(['.proof-or-stop/story/actives/B-x/index.json', 'packages/main/src/core/x.ts']) === true);
    check('isDoneMainRuntimeBuildInput: brand src file', isDoneMainRuntimeBuildInput('packages/main/src/core/proof-or-stop-brand.ts') === true);
    check('isDoneMainRuntimeBuildInput: docs/CLI.md -> true', isDoneMainRuntimeBuildInput('docs/CLI.md') === true);
    check('isDoneMainRuntimeBuildInput: packages/main/tests file -> true', isDoneMainRuntimeBuildInput('packages/main/tests/milestone-status.test.mjs') === true);
    check('isDoneMainRuntimeBuildInput: experiments harness -> false', isDoneMainRuntimeBuildInput('experiments/tier-c-proof/sum.mjs') === false);
    check('isDoneMainRuntimeBuildInput: arbitrary docs file -> false', isDoneMainRuntimeBuildInput('docs/readme.md') === false);
    check('isDoneMainRuntimeBuildInput: requirements doc -> false', isDoneMainRuntimeBuildInput('docs/requirements/decisions/story-lifecycle.md') === false);

    // 5. bumpVersionOnDoneMerge SKIPS cleanly when not qualifying (no FS change, no git).
    const f5 = fixture('0.9.9');
    let f5GitCalls = 0;
    const skipLine = bumpVersionOnDoneMerge({ mainMergeRoot: f5, shouldBump: false, runGit: () => { f5GitCalls += 1; return ''; } });
    check('skip returns the watched-runtime-or-capability-input skip line', skipLine === VERSION_BUMP_SKIPPED_LINE);
    check('skip line says no watched CLI/runtime or capability contract inputs changed', skipLine.includes('no watched CLI/runtime or capability contract inputs changed'));
    check('skip line no longer uses the retired material-code clause', !skipLine.includes(['no material', 'code change'].join(' ')));
    check('skip made no git calls', f5GitCalls === 0);
    check('skip left the version unchanged', readSyncedVersion(f5) === '0.9.9');

    // 6. bumpVersionOnDoneMerge COMMITS when qualifying: files bumped + git add + chore:bump commit.
    const f6 = fixture('0.9.9');
    const gitCalls: Array<{ args: string[]; cwd: string }> = [];
    const line6 = bumpVersionOnDoneMerge({ mainMergeRoot: f6, shouldBump: true, runGit: (args, cwd) => { gitCalls.push({ args, cwd }); return ''; } });
    check('bump line reports 0.9.9 -> 0.9.10', line6.includes('0.9.9') && line6.includes('0.9.10'));
    check('bump line contains the "auto-bumped" keyword (per the intent)', line6.includes('auto-bumped'));
    check('bump wrote the new version', readSyncedVersion(f6) === '0.9.10');
    check('git add was issued', gitCalls.some((c) => c.args[0] === 'add' && c.args.includes(VERSION_SYNC_FILES.brand)));
    check('git add includes package lockfiles', gitCalls.some((c) => c.args[0] === 'add' && c.args.includes(VERSION_SYNC_FILES.rootPackageLock) && c.args.includes(VERSION_SYNC_FILES.mainPackageLock)));
    check('chore:bump commit was issued', gitCalls.some((c) => c.args.includes('commit') && c.args.some((a) => a === 'chore: bump proof-or-stop cli to 0.9.10')));
    check('git ran in the main merge root', gitCalls.every((c) => c.cwd === f6));

    const f6pre = fixture('0.9.10');
    let preBumpedGitCalls = 0;
    const preBumpedLine = bumpVersionOnDoneMerge({
      mainMergeRoot: f6pre,
      shouldBump: true,
      preMergeVersion: '0.9.9',
      runGit: () => { preBumpedGitCalls += 1; return ''; },
    });
    check('pre-bumped DONE finalizer reports already present 0.9.9 -> 0.9.10', preBumpedLine.includes('already present 0.9.9') && preBumpedLine.includes('0.9.10'));
    check('pre-bumped DONE finalizer makes no git commit', preBumpedGitCalls === 0);
    check('pre-bumped DONE finalizer leaves version at next patch only', readSyncedVersion(f6pre) === '0.9.10');

    // 7. Idempotent: each applyPatchBump call increments by exactly one (no accumulation).
    const f7 = fixture('0.9.9');
    check('first bump -> 0.9.10', applyPatchBump(f7).to === '0.9.10');
    check('second bump -> 0.9.11', applyPatchBump(f7).to === '0.9.11');
    check('two bumps land on 0.9.11', readSyncedVersion(f7) === '0.9.11');

    // 8. parseSemver returns the numeric struct (the parse all else depends on).
    const ps = parseSemver('1.2.3');
    check('parseSemver(1.2.3) -> {1,2,3}', ps.major === 1 && ps.minor === 2 && ps.patch === 3);

    // 9. Large patch increments with no overflow cap.
    check('nextPatch large patch 0.3.999 -> 0.3.1000', nextPatch('0.3.999') === '0.3.1000');

    // 10. Strict X.Y.Z: reject v-prefix, non-numeric, empty.
    throws('parseSemver rejects v-prefixed v1.2.3', () => parseSemver('v1.2.3'));
    throws('parseSemver rejects non-numeric abc', () => parseSemver('abc'));
    throws('parseSemver rejects empty string', () => parseSemver(''));

    // 11. Adversarial: a DUPLICATE exported PROOF_OR_STOP_CLI_VERSION is ambiguous and must THROW —
    //     never silently pick one (the old "reads first" behavior could bump nothing real).
    const fdup = fixture('0.9.9');
    writeFileSync(
      join(fdup, VERSION_SYNC_FILES.brand),
      `export const PROOF_OR_STOP_CLI_VERSION = '0.9.9' as const;\nexport const PROOF_OR_STOP_CLI_VERSION = '0.9.9' as const;\n`,
    );
    throws('duplicate exported PROOF_OR_STOP_CLI_VERSION -> readSyncedVersion throws', () => readSyncedVersion(fdup));
    throws('duplicate exported PROOF_OR_STOP_CLI_VERSION -> applyPatchBump refuses', () => applyPatchBump(fdup));

    // 12. Adversarial: a COMMENT mentioning PROOF_OR_STOP_CLI_VERSION must NOT be mistaken for the
    //     export. Read + bump target the real `export const`; the comment is left untouched.
    const fcomment = fixture('0.9.9');
    writeFileSync(
      join(fcomment, VERSION_SYNC_FILES.brand),
      `// historical: PROOF_OR_STOP_CLI_VERSION = '9.9.9'\nexport const PROOF_OR_STOP_CLI_VERSION = '0.9.9' as const;\n`,
    );
    check('comment ignored; reads the real export (0.9.9)', readSyncedVersion(fcomment) === '0.9.9');
    applyPatchBump(fcomment);
    const commentBrand = readFileSync(join(fcomment, VERSION_SYNC_FILES.brand), 'utf-8');
    check('bump targeted the export -> 0.9.10', readSyncedVersion(fcomment) === '0.9.10');
    check('the comment line stayed at 9.9.9 (untouched)', commentBrand.includes("// historical: PROOF_OR_STOP_CLI_VERSION = '9.9.9'"));

    // 12b. Adversarial: a COMMENTED-OUT export line (`// export const ...`) is NOT the real
    //      constant — the line-start anchor skips it; the real export below is read/bumped.
    const fcommentExport = fixture('0.9.9');
    writeFileSync(
      join(fcommentExport, VERSION_SYNC_FILES.brand),
      `// export const PROOF_OR_STOP_CLI_VERSION = '9.9.9' as const;\nexport const PROOF_OR_STOP_CLI_VERSION = '0.9.9' as const;\n`,
    );
    check('commented-out export ignored; reads the real export (0.9.9)', readSyncedVersion(fcommentExport) === '0.9.9');
    applyPatchBump(fcommentExport);
    const ceBrand = readFileSync(join(fcommentExport, VERSION_SYNC_FILES.brand), 'utf-8');
    check('bump targeted the real export -> 0.9.10', readSyncedVersion(fcommentExport) === '0.9.10');
    check('commented-out export line stayed at 9.9.9', ceBrand.includes("// export const PROOF_OR_STOP_CLI_VERSION = '9.9.9'"));

    // 12c. A brand file whose ONLY PROOF_OR_STOP_CLI_VERSION is a commented-out export has no real
    //      exported constant -> readSyncedVersion throws (never bumps inside a comment).
    const fonlyComment = fixture('0.9.9');
    writeFileSync(join(fonlyComment, VERSION_SYNC_FILES.brand), `// export const PROOF_OR_STOP_CLI_VERSION = '0.9.9' as const;\n`);
    throws('brand with ONLY a commented-out export throws (no real export)', () => readSyncedVersion(fonlyComment));

    // 13. Adversarial: extra whitespace around the export survives a full WRITE round-trip
    //     (read AND applyPatchBump), not just the read path.
    const fws = fixture('0.9.9');
    writeFileSync(join(fws, VERSION_SYNC_FILES.brand), `export const   PROOF_OR_STOP_CLI_VERSION  =  '0.9.9'  as const;\n`);
    check('whitespace-padded export reads correctly', readSyncedVersion(fws) === '0.9.9');
    check('whitespace-padded export bumps correctly (write round-trip)', applyPatchBump(fws).to === '0.9.10');
    check('whitespace-padded export now 0.9.10', readSyncedVersion(fws) === '0.9.10');

    // 14. Adversarial: STRUCTURAL top-level bump — a nested "version" equal to `from` placed
    //     BEFORE the top-level field is NOT touched; only the package version moves.
    const fnest = fixture('0.9.9');
    writeFileSync(
      join(fnest, VERSION_SYNC_FILES.rootPackageJson),
      `{\n  "name": "proof-or-stop",\n  "engines": { "version": "0.9.9" },\n  "version": "0.9.9"\n}\n`,
    );
    applyPatchBump(fnest);
    const nestPkg = JSON.parse(readFileSync(join(fnest, VERSION_SYNC_FILES.rootPackageJson), 'utf-8'));
    check('top-level version bumped to 0.9.10', nestPkg.version === '0.9.10');
    check('nested version left at 0.9.9 (structural, not first-substring)', nestPkg.engines.version === '0.9.9');

    // 15. Adversarial: a read-only sync file makes applyPatchBump throw AND roll back to `from`
    //     with no partial corruption — covered for the FIRST written file (root) and the LAST
    //     (brand, after the other two were already written). Skipped under root (0444 ignored).
    if (typeof process.getuid === 'function' && process.getuid() !== 0) {
      const froRoot = fixture('0.9.9');
      chmodSync(join(froRoot, VERSION_SYNC_FILES.rootPackageJson), 0o444);
      throws('read-only ROOT package.json (first write) -> applyPatchBump throws', () => applyPatchBump(froRoot));
      chmodSync(join(froRoot, VERSION_SYNC_FILES.rootPackageJson), 0o644);
      check('first-file read-only failure rolled back: all 3 still 0.9.9', readSyncedVersion(froRoot) === '0.9.9');

      const froBrand = fixture('0.9.9');
      chmodSync(join(froBrand, VERSION_SYNC_FILES.brand), 0o444);
      throws('read-only BRAND (last write) -> applyPatchBump throws', () => applyPatchBump(froBrand));
      chmodSync(join(froBrand, VERSION_SYNC_FILES.brand), 0o644);
      check('last-file read-only failure rolled back: all 3 reverted to 0.9.9', readSyncedVersion(froBrand) === '0.9.9');
    } else {
      check('read-only rollback cases skipped under root (0444 does not block root writes)', true);
    }

    // 15b. Adversarial: a git failure AFTER the files are written propagates with an actionable recovery message.
    const fcommit = fixture('0.9.9');
    let commitErr = '';
    try {
      bumpVersionOnDoneMerge({
        mainMergeRoot: fcommit,
        shouldBump: true,
        runGit: (args) => { if (args.includes('commit')) throw new Error('simulated commit failure'); return ''; },
      });
    } catch (e) {
      commitErr = e instanceof Error ? e.message : String(e);
    }
    check('commit failure throws with a recovery message (git commit + target version)', commitErr.includes('git commit') && commitErr.includes('0.9.10'));

    // 16. Adversarial: a BLOCK-commented export (Codex round-3 repro) is not the real constant.
    const fblock = fixture('0.9.9');
    writeFileSync(join(fblock, VERSION_SYNC_FILES.brand), `/*\nexport const PROOF_OR_STOP_CLI_VERSION = '0.9.9' as const;\n*/\n`);
    throws('brand with ONLY a block-commented export throws (no real export)', () => readSyncedVersion(fblock));
    throws('applyPatchBump refuses a block-comment-only brand', () => applyPatchBump(fblock));

    // 17. Adversarial: a real export PLUS a block-comment export-shaped line is ambiguous -> throws.
    const fblock2 = fixture('0.9.9');
    writeFileSync(
      join(fblock2, VERSION_SYNC_FILES.brand),
      `/*\nexport const PROOF_OR_STOP_CLI_VERSION = '9.9.9' as const;\n*/\nexport const PROOF_OR_STOP_CLI_VERSION = '0.9.9' as const;\n`,
    );
    throws('real + block-comment export-shaped line -> ambiguous, throws', () => readSyncedVersion(fblock2));

    // 18. Adversarial: a post-write VERIFICATION throw (drift introduced after writes) rolls back.
    const fverThrow = fixture('0.9.9');
    throws('verify-throw (post-write drift) -> applyPatchBump throws', () => applyPatchBump(fverThrow, {
      afterWriteForTest: () => writeFileSync(join(fverThrow, VERSION_SYNC_FILES.mainPackageLock), JSON.stringify({
        name: '@proof-or-stop/core',
        version: '5.5.5',
        lockfileVersion: 3,
        packages: { '': { name: '@proof-or-stop/core', version: '5.5.5' } },
      }, null, 2) + '\n'),
    }));
    check('verify-throw rolled back: all sync points restored to 0.9.9', readSyncedVersion(fverThrow) === '0.9.9');

    // 19. Adversarial: a post-write WRONG-VALUE (synced but != to) also rolls back.
    const fverWrong = fixture('0.9.9');
    throws('verify wrong-value -> applyPatchBump throws', () => applyPatchBump(fverWrong, {
      afterWriteForTest: () => {
        writeFileSync(join(fverWrong, VERSION_SYNC_FILES.rootPackageJson), `{\n  "name": "proof-or-stop",\n  "version": "7.7.7"\n}\n`);
        writeFileSync(join(fverWrong, VERSION_SYNC_FILES.rootPackageLock), JSON.stringify({
          name: 'proof-or-stop',
          version: '7.7.7',
          lockfileVersion: 3,
          packages: {
            '': { name: 'proof-or-stop', version: '7.7.7' },
            'packages/main': { name: '@proof-or-stop/core', version: '7.7.7' },
          },
        }, null, 2) + '\n');
        writeFileSync(join(fverWrong, VERSION_SYNC_FILES.mainPackageJson), `{\n  "name": "@proof-or-stop/core",\n  "version": "7.7.7"\n}\n`);
        writeFileSync(join(fverWrong, VERSION_SYNC_FILES.mainPackageLock), JSON.stringify({
          name: '@proof-or-stop/core',
          version: '7.7.7',
          lockfileVersion: 3,
          packages: { '': { name: '@proof-or-stop/core', version: '7.7.7' } },
        }, null, 2) + '\n');
        writeFileSync(join(fverWrong, VERSION_SYNC_FILES.brand), `export const PROOF_OR_STOP_CLI_VERSION = '7.7.7' as const;\n`);
      },
    }));
    check('verify wrong-value rolled back: all sync points restored to 0.9.9', readSyncedVersion(fverWrong) === '0.9.9');

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
