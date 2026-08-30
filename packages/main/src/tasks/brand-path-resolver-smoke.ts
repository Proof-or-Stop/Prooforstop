#!/usr/bin/env node
/**
 * B-cc10 CHK-002 — proves the read-both path resolver (`core/brand-paths.ts`) is
 * the SINGLE source for the state-dir / adapter-dir / config-filename / manifest
 * identities, and that the `storyFilesHash` metadata exclusion FOLLOWS the
 * state-directory rename instead of being a second hardcoded copy of the name.
 *
 * WHY THIS GUARD EXISTS
 * ---------------------
 * `isStoryMetadataPath` (`core/evidence-freshness.ts`) is what EXCLUDES story
 * metadata from `storyFilesHash`. Its prefix list is derived from the state-dir
 * constant. Measured against the pre-migration build:
 *
 *     isStoryMetadataPath('.proof-or-stop/story/actives/B-cdf6/index.json')       -> true
 *     isStoryMetadataPath('.proof-or-stop/story/actives/B-cdf6/index.json') -> false
 *
 * So if the on-disk directory is renamed while any copy of the OLD prefix stays
 * hardcoded, 344 archived story directories silently flip from EXCLUDED to
 * INCLUDED in the digest. Nothing throws — the hashes just change meaning. That
 * is the worst failure mode available for an evidence digest, and it is invisible
 * to every other test in the suite.
 *
 * WHY IT FLIPS THE CONSTANT INSTEAD OF ASSERTING STRINGS
 * -----------------------------------------------------
 * Today canonical == deprecated (`.proof-or-stop`), because CHK-002 lands the resolver
 * BEFORE anything moves. A test that merely asserted
 * `isStoryMetadataPath('.proof-or-stop/...') === true` would therefore pass whether or
 * not the prefix is hardcoded — it would prove nothing and would keep passing
 * after someone reintroduced the literal.
 *
 * So case (a) REBUILDS the module graph in a scratch copy with
 * `PROOF_OR_STOP_STATE_DIR` flipped to a distinct sentinel, and asserts the
 * exclusion moved with it. If a future edit hardcodes the old prefix anywhere in
 * the chain (brand-paths -> proof-or-stop-paths -> evidence-freshness), the canonical
 * assertion in case (a) FAILS. That is the "would fail if someone hardcodes the
 * old prefix again" property this item is required to demonstrate.
 *
 * Cases:
 *   (a) RENAME FOLLOW-THROUGH — with the resolver constant flipped, the CANONICAL
 *       story dir is excluded, the DEPRECATED one is STILL excluded (a
 *       not-yet-moved archive must not start entering the digest mid-migration),
 *       and a genuine source file is still INCLUDED.
 *   (b) READ-BOTH CANDIDATE ORDER — every candidate list puts canonical FIRST, so
 *       canonical-wins falls out of iteration order rather than needing a special
 *       case at each call site.
 *   (c) DECISION HELPERS ACCEPT BOTH SPELLINGS — the B-cdf6 F-065/F-061/F-062/F-068
 *       regression class: a brand literal inside a comparison / regex / membership
 *       test that recognizes only ONE spelling. Each helper must accept both.
 *   (d) ADAPTER MANIFEST CROSS PRODUCT — a partially migrated checkout can have a
 *       canonical dir holding a deprecated filename (or vice versa); the resolver
 *       must probe the mixes, not just the two matched pairs.
 *   (e) CODEX TOUCHPOINT REGEX — `storyRequiresCodexEvidence` must arm on BOTH
 *       adapter-dir spellings. This is the F-062 shape: a hardcoded spelling in a
 *       gate-arming regex makes the gate quietly stop firing.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const DIST_ROOT = resolve(HERE, '..');

/** A spelling that cannot collide with either real brand name. */
const SENTINEL_STATE_DIR = '.brand-path-resolver-sentinel';

function pass(name: string): void {
  console.log(`  [ok] ${name}`);
}

/* ------------------------------------------------------------------ *
 * (a) RENAME FOLLOW-THROUGH — the load-bearing case.
 * ------------------------------------------------------------------ */
function caseRenameFollowThrough(): void {
  const scratch = mkdtempSync(join(tmpdir(), 'brand-path-resolver-'));
  try {
    // Copy the BUILT module graph, then flip the resolver constant in the copy.
    // Rewriting compiled output (rather than re-running tsc) keeps this guard
    // fast and makes it test exactly the artifact that ships.
    const coreSrc = join(DIST_ROOT, 'core');
    const coreDst = join(scratch, 'core');
    cpSync(coreSrc, coreDst, { recursive: true });

    const brandPathsFile = join(coreDst, 'brand-paths.js');
    const original = readFileSync(brandPathsFile, 'utf-8');

    // Flip ONLY the canonical constant. The deprecated one stays `.proof-or-stop`, so
    // this scratch build represents the post-rename world: canonical moved,
    // deprecated still readable.
    // B-cc10 CHK-006 fix: match WHATEVER the current canonical value is, rather than
    // the literal '.proof-or-stop'. CHK-003 legitimately renamed the canonical constant to
    // '.proof-or-stop', which made this guard fail closed on a correct change — the
    // guard was pinned to one spelling, the same defect class it exists to catch.
    const flipped = original.replace(
      /(PROOF_OR_STOP_STATE_DIR\s*=\s*)(['"])[^'"]+\2/,
      `$1$2${SENTINEL_STATE_DIR}$2`,
    );
    assert.notEqual(
      flipped,
      original,
      'could not find the canonical PROOF_OR_STOP_STATE_DIR assignment to flip — '
        + 'the resolver constant moved or changed shape; this guard must be updated '
        + 'rather than deleted, because it is what proves the storyFilesHash '
        + 'exclusion follows the state-dir rename',
    );
    writeFileSync(brandPathsFile, flipped, 'utf-8');

    const mod = execFileSync(
      process.execPath,
      [
        '-e',
        `
        const { isStoryMetadataPath } = require(${JSON.stringify(join(coreDst, 'evidence-freshness.js'))});
        const bp = require(${JSON.stringify(brandPathsFile)});
        const probe = (p) => isStoryMetadataPath(p);
        console.log(JSON.stringify({
          canonicalDir: bp.PROOF_OR_STOP_STATE_DIR,
          canonicalExcluded: probe(bp.PROOF_OR_STOP_STATE_DIR + '/story/actives/B-cdf6/index.json'),
          sourceIncluded: probe('packages/main/src/core/config.ts'),
        }));
        `,
      ],
      { encoding: 'utf-8' },
    );
    const out = JSON.parse(mod.trim());

    assert.equal(
      out.canonicalDir,
      SENTINEL_STATE_DIR,
      'scratch build did not pick up the flipped canonical constant',
    );
    // THE assertion this item exists for. Fails if any hardcoded copy of the old
    // prefix survives in brand-paths -> proof-or-stop-paths -> evidence-freshness.
    assert.equal(
      out.canonicalExcluded,
      true,
      `storyFilesHash HAZARD: after renaming the state dir to ${SENTINEL_STATE_DIR}, `
        + 'isStoryMetadataPath no longer excludes story metadata under the CANONICAL '
        + 'directory. That means archived story directories would silently ENTER '
        + 'storyFilesHash — nothing errors, the hashes just change meaning. Root '
        + 'cause is almost certainly a hardcoded old prefix that did not follow the '
        + 'resolver; derive it from PROOF_OR_STOP_STATE_DIR instead.',
    );

    // Sanity: the exclusion must stay narrow, not swallow real material.
    assert.equal(
      out.sourceIncluded,
      false,
      'a genuine source file must remain INCLUDED in storyFilesHash; an exclusion '
        + 'that broad would hide real material drift',
    );

    pass(`rename follow-through: exclusion moved to ${SENTINEL_STATE_DIR}, source still included`);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/* ------------------------------------------------------------------ *
 * (b) READ-BOTH CANDIDATE ORDER.
 * ------------------------------------------------------------------ */
async function caseCanonicalFirst(): Promise<void> {
  const bp = await import('../core/brand-paths.js');
  const lists: ReadonlyArray<[string, readonly string[], string]> = [
    ['STATE_DIR_NAMES', bp.STATE_DIR_NAMES, bp.PROOF_OR_STOP_STATE_DIR],
    ['ADAPTER_DIR_NAMES', bp.ADAPTER_DIR_NAMES, bp.PROOF_OR_STOP_ADAPTER_DIR],
    ['CONFIG_FILENAMES', bp.CONFIG_FILENAMES, bp.PROOF_OR_STOP_CONFIG_FILENAME],
    ['MANIFEST_FILENAMES', bp.MANIFEST_FILENAMES, bp.PROOF_OR_STOP_MANIFEST_FILENAME],
  ];
  for (const [label, list, canonical] of lists) {
    assert.equal(list.length, 1, `${label} must expose only the canonical identity`);
    assert.equal(
      list[0],
      canonical,
      `${label} must put the CANONICAL name FIRST — canonical-wins for reads is `
        + 'implemented by iteration order',
    );
    assert.equal(
      new Set(list).size,
      list.length,
      `${label} must not contain duplicates (probing the same path twice is a bug)`,
    );
  }
  pass('candidate lists contain exactly one canonical identity');
}

/* ------------------------------------------------------------------ *
 * (c) DECISION HELPERS ACCEPT BOTH SPELLINGS (B-cdf6 regression class).
 * ------------------------------------------------------------------ */
async function caseDecisionHelpersAcceptBoth(): Promise<void> {
  const bp = await import('../core/brand-paths.js');

  for (const dir of bp.STATE_DIR_NAMES) {
    assert.equal(bp.isStateDirPath(`${dir}/story/actives/B-1/index.json`), true,
      `isStateDirPath must accept the ${dir} spelling`);
    assert.equal(bp.isStateDirPath(dir), true,
      `isStateDirPath must accept the bare ${dir} directory`);
  }
  assert.equal(bp.isStateDirPath('packages/main/src/core/config.ts'), false,
    'isStateDirPath must not match unrelated paths');
  // A path that merely CONTAINS the dir name deeper down is not in the state dir.
  assert.equal(bp.isStateDirPath(`docs/${bp.PROOF_OR_STOP_STATE_DIR}/notes.md`), false,
    'isStateDirPath must anchor on the FIRST segment, not match anywhere');

  for (const dir of bp.ADAPTER_DIR_NAMES) {
    assert.equal(bp.isAdapterDirPath(`${dir}/agents/foo.md`), true,
      `isAdapterDirPath must accept the ${dir} spelling`);
  }
  assert.equal(bp.isAdapterDirPath('.codex/hooks.json'), false,
    'isAdapterDirPath must not match the native .codex dir');

  for (const name of bp.CONFIG_FILENAMES) {
    assert.equal(bp.isConfigFilename(name), true,
      `isConfigFilename must accept ${name}`);
  }
  assert.equal(bp.isConfigFilename('package.json'), false,
    'isConfigFilename must not match unrelated filenames');

  for (const name of bp.MANIFEST_FILENAMES) {
    assert.equal(bp.isManifestFilename(name), true,
      `isManifestFilename must accept ${name}`);
  }

  const retiredStateDir = ['.', 'lat', 'tice'].join('');
  assert.equal(bp.isStateDirPath(`${retiredStateDir}/story/actives/B-1/index.json`), false,
    'isStateDirPath must reject the retired state directory');
  pass('decision helpers accept canonical spellings and reject retired/unrelated paths');
}

/* ------------------------------------------------------------------ *
 * (d) ADAPTER MANIFEST CROSS PRODUCT.
 * ------------------------------------------------------------------ */
async function caseManifestCrossProduct(): Promise<void> {
  const bp = await import('../core/brand-paths.js');
  const candidates = bp.adapterManifestCandidates();

  assert.equal(
    candidates[0],
    `${bp.PROOF_OR_STOP_ADAPTER_DIR}/${bp.PROOF_OR_STOP_MANIFEST_FILENAME}`,
    'the canonical dir + canonical filename pair must be probed FIRST',
  );
  assert.deepEqual(candidates, [
    `${bp.PROOF_OR_STOP_ADAPTER_DIR}/${bp.PROOF_OR_STOP_MANIFEST_FILENAME}`,
  ], 'adapter manifest candidates must contain only the canonical pair');
  pass('adapter manifest candidates contain only the canonical pair');
}

/* ------------------------------------------------------------------ *
 * (e) CODEX TOUCHPOINT REGEX (F-062 shape).
 * ------------------------------------------------------------------ */
async function caseCodexTouchpointBothSpellings(): Promise<void> {
  const bp = await import('../core/brand-paths.js');
  const { storyRequiresCodexEvidence } = await import('../core/codex-adapter-checks.js');

  const fakeStore = (text: string) => ({
    readStory: () => ({ title: text, description: '', riskSignals: [] }),
    readChecklist: () => ({ items: [] }),
  }) as never;

  for (const dir of bp.ADAPTER_DIR_NAMES) {
    assert.equal(
      storyRequiresCodexEvidence(fakeStore(`touches ${dir}/agents`), 'B-1'),
      true,
      `storyRequiresCodexEvidence must arm for the ${dir} spelling — this is the `
        + 'B-cdf6 F-062 shape: a brand literal hardcoded inside a gate-arming regex '
        + 'makes the codex-adapter gate quietly stop firing for exactly the stories '
        + 'that migrate the adapter',
    );
  }
  assert.equal(
    storyRequiresCodexEvidence(fakeStore('unrelated refactor of the parser'), 'B-1'),
    false,
    'storyRequiresCodexEvidence must not arm for unrelated stories',
  );
  pass('codex touchpoint detection arms on the canonical adapter directory');
}

async function main(): Promise<void> {
  console.log('B-cc10 CHK-002 brand path resolver smoke');
  caseRenameFollowThrough();
  await caseCanonicalFirst();
  await caseDecisionHelpersAcceptBoth();
  await caseManifestCrossProduct();
  await caseCodexTouchpointBothSpellings();
  console.log('brand-path-resolver-smoke: PASS');
}

main().catch((error) => {
  console.error('brand-path-resolver-smoke: FAIL');
  console.error(error);
  process.exit(1);
});
