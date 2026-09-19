# Validation entrypoint pin review

This records the bounded review basis requested by independent Lab audit `7d0971ba-fc32-423c-86ea-f5c746154c78`. It is source-review evidence, not an independent PASS or Story DONE. All diffs below are complete file diffs through main `e31861b756446b8ad9861c62320fe1cf85701023`. The executable guard keeps the same approved symbols, occurrence counts, call shapes and exact-fingerprint requirements.

## bin/bootstrap-runner.js

Previous pinned source: `343554c4caedc2e127e023f85d71ad3d47705ac1`. Canonical SHA-256: `d0fa3e4ebad2c985e96f1faa64cd3ca7eac35492203f0eacc121e260298e715e` → `19b243083de02b86b17a76c104222709b35cc223b3a5e2ad4d40ff86e99ad0ed`. Both use TypeScript 5.9.3 with comments removed and LF output.

Main changes `677b259fc8d78c248a6fd278d6d42340f9e7e733` and `c25111ba48ba40c2ad844e5cb6c04f50e174cfaa` refine runtime mismatch diagnostics. The net change prints the original mismatch and returns before suggesting a generic fallback. No executable loader, eval, Function, require, or vm call is added or changed.

Machine-compared sensitive call inventory (identical before/after):

```json
{
  "sites": [
    "import(pathToFileURL(BRAND_ENV_DIST).href)",
    "import(pathToFileURL(LAB_DIST).href)",
    "import(pathToFileURL(join(repoRoot, 'scripts', 'build-lock.mjs')).href)",
    "import(pathToFileURL(MAIN_DIST).href)",
    "import(pathToFileURL(UTILS_DIST).href)",
    "import('zod')"
  ],
  "legacyOccurrences": {}
}
```

Complete change from the previously pinned source:

```diff
diff --git a/bin/bootstrap-runner.js b/bin/bootstrap-runner.js
index c3ba1bb775..9af4ab65ab 100644
--- a/bin/bootstrap-runner.js
+++ b/bin/bootstrap-runner.js
@@ -27,6 +27,12 @@ const UTILS_DIST = join(repoRoot, 'packages', 'utils', 'dist', 'index.js');
 const LAB_DIST = join(repoRoot, 'packages', 'lab', 'dist', 'index.js');
 
 function printBootstrapFailure(error) {
+  if (/^(?:Error:[ \t]*)?CLI_RUNTIME_VERSION_(?:MISMATCH|METADATA_INVALID):/m.test(String(error?.message ?? ''))) {
+    // Both entry shapes would reject the same installation. Do not advertise
+    // the generic fallback as recovery from a runtime package mismatch.
+    console.error(error.message);
+    return;
+  }
   const missing = [];
   if (!existsSync(MAIN_DIST)) missing.push(MAIN_DIST);
   if (!existsSync(UTILS_DIST)) missing.push(UTILS_DIST);
```

## packages/main/src/core/closeout-trust.ts

Previous pinned source: `ef854edb5a16f01dbd7f92a4f1130649d7f80e1a`. Canonical SHA-256: `fb21d100ac76f9211b3311c04c94e7d8856bc974e29292c8b3485cab485263f5` → `68d86faa065e9137986d20775fa8d72ab8e71af6ddf648c9ab94d48be2db7467`. Both use TypeScript 5.9.3 with comments removed and LF output.

Main changes `db0338a3b60fd2f9714fcfdab60882549e869e90`, `7033cc0152d5d8e77b95f7b511415cfcc3e779ad`, `2a592a0a98fbe38f49a2185f6b778415a2597e4b`, `70a825faa9ecd9ded026f3fc4b16ec322282710e`, and `9b7342fa929f70a198220d97d0484831993749a5` refine review retention. The net executable change refuses direct verification_evidence_add receipts in the closeout retention classifier; it narrows retention authority. Approved legacy symbols, their occurrence counts and call expressions are identical before/after.

Machine-compared sensitive call inventory (identical before/after):

```json
{
  "sites": [
    "isExactLegacyLocalOnlyDeliveryClaims(claims)"
  ],
  "legacyOccurrences": {
    "isExactLegacyLocalOnlyDeliveryClaims": 2,
    "LegacyLocalOnlyDeliveryClaims": 2
  }
}
```

Complete change from the previously pinned source:

```diff
diff --git a/packages/main/src/core/closeout-trust.ts b/packages/main/src/core/closeout-trust.ts
index a889ccd8fd..6644441db6 100644
--- a/packages/main/src/core/closeout-trust.ts
+++ b/packages/main/src/core/closeout-trust.ts
@@ -48,8 +48,9 @@ export const CLOSEOUT_ARTIFACT_POLICIES = [
   { path: 'topology-critic-receipt.json', artifactClass: 'closeout-evidence', canonicalWriters: ['topology_critic_receipt_set'] },
   // A stale-evidence refresh only re-executes already-pinned verification and
   // replaces its evidence rows; it cannot create or change verification intent.
-  // Other checklist writers are deliberately absent because they may alter
-  // checklist status or acceptance semantics and therefore require re-review.
+  // Direct evidence publication is retained only by the strict V5 refresh
+  // classifier below: identical covered refs/results and unchanged requirements.
+  // Other checklist writers require re-review.
   { path: 'checklist.json', artifactClass: 'closeout-evidence', canonicalWriters: ['verification_evidence_refresh_stale'] },
   { path: 'parent-ledger-rollup.json', artifactClass: 'closeout-evidence', canonicalWriters: ['parent_ledger_rollup_set'] },
   { path: 'evidence/delivery-context-pack.json', artifactClass: 'closeout-evidence', canonicalWriters: ['delivery_context_pack'] },
@@ -655,7 +656,9 @@ export function classifyCurrentCloseoutArtifactForReviewRetention(
       artifactPath,
       { projectRoot, metadataRoot },
     );
-    if (!receipt) {
+    // Defence in depth: current canonical policies already exclude direct writes;
+    // retain this refusal if a future policy edit accidentally widens them.
+    if (!receipt || receipt.writerCommand === 'verification_evidence_add') {
       return {
         retainsReview: false,
         writer: '',
```


## Controller projection and static dependency review — 2026-09-19

Independent audit `3a0dfeed-e65f-465e-b9c6-e4fde132c6a3` identified a missing dependency rebind. The CLI source at main `e31861b756446b8ad9861c62320fe1cf85701023` has raw SHA-256 `6bd4879a208cc3de63964002a53a1e8f6174fd9f919950675c55b9d38fee97d0`; this repair changes it to `9565d5a47e3dc1d484d1a8cb73c915391f33a09f477c5c27f771dcb1332df850`.

`EX-TRACKED-CONTROLLER-BOOTSTRAP` covers fixed `aux_doc_list`, `dispatch`, and `review_run_start` commands in owned temporary Git roots. All three retain the original projection paths. The new condition applies only to `story_discard`; it retains the controller root that the existing root resolver already chose. Later handler admission remains active. The discard suite covers invalid linked-checkout recovery; the tracked-controller suite independently covers tracked branch config preservation, normal scope rejection, signed untracked projection, reciprocal bootstrap, and ownership negative controls.

Both manifest entries that pin the CLI (`EX-TRACKED-CONTROLLER-BOOTSTRAP` and `EX-PROCESS-RUNTIME-ADMISSION-ORDER`) retain their commands, call expressions, timeouts, selectors, and isolation claims. Rebinding accepts these reviewed source bytes, not additional commands. `EX-0129` retains its original call digest; its key and source excerpt only move by the inserted guard review comments.

The complete existing root selection functions from `packages/main/src/cli/runtime-root.ts` (whole-file SHA-256 `f9f0f13ba95cf58f5c25e8771d9dffc0b996ea0817c9d4f62ed6c8de019dd433`) are reproduced below to make the controller-root claim reviewable. This file is unchanged by the repair.

```typescript
export function resolveRoot(explicit?: string): string {
  if (explicit) return explicit;
  const envRoot = readBrandEnv('PROJECT_ROOT');
  if (envRoot) return envRoot;
  let dir = process.cwd();
  for (let i = 0; i < 10; i++) {
    if (hasProjectConfigFile(dir)) return dir;
    const parent = join(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }
  const commonDir = gitProbe('git rev-parse --git-common-dir');
  if (commonDir.ok) {
    const cd = commonDir.output;
    if (cd !== '.git' && !cd.endsWith('/.git') && !cd.endsWith('\\.git')) {
      const wtList = gitProbe('git worktree list --porcelain');
      if (wtList.ok) {
        return wtList.output.split('\n')[0]?.replace('worktree ', '').trim() || process.cwd();
      }
    }
  }
  return process.cwd();
}

export function resolveMainRootFromWorktreeRoot(root: string): string | null {
  try {
    const dotGit = join(root, '.git');
    if (!existsSync(dotGit)) return null;
    const content = readFileSync(dotGit, 'utf-8').trim();
    const m = content.match(/^gitdir:\s*(.+)$/i);
    if (!m) return null;
    const gitdir = m[1].trim();
    const absGitdir = gitdir.startsWith('/') ? gitdir : join(root, gitdir);
    const marker = `${join('.git', 'worktrees')}`;
    const normalized = absGitdir.replace(/\\/g, '/');
    const markerNormalized = marker.replace(/\\/g, '/');
    const idx = normalized.indexOf(`/${markerNormalized}/`);
    if (idx === -1) return null;
    return normalized.slice(0, idx);
  } catch {
    return null;
  }
}

export function resolveRootForCommand(cmd: string | undefined, explicit?: string): string {
  const root = resolveRoot(explicit);
  if (cmd !== 'story_discard') return root;
  return resolveMainRootFromWorktreeRoot(root) || root;
}

```

The complete runtime verifier exposed the already-repaired parser-cache bypass in the original Lab. The carried one-line scanner fix routes `routeLoadsSupportHelper` through `parseStaticSource`, preserving the same TypeScript parser arguments and full AST traversal. The runtime regression compares complete scanner reports with cache bypassed versus enabled, requires identical reports and unique candidate parser inputs, and retains independent boundary controls. This is the same source change as original repair `897de955674f7c6153dd940872d171f64f7977e4`.

Acceptance now requires the complete static-edge verifier, complete runtime-fact verifier (which actually invokes tracked-controller bootstrap and parser-reuse controls), and the original three full entrypoint suites twice. Failed provider/source-binding audits remain in the Lab history. No verifier assertion, exception membership, or protected call allowance is broadened.

The expanded runtime suite also reproduced the pre-existing strict-argument ordering false failure twice: the CLI call is multiline and has an optional display-alias argument, but the old locator requires the exact historical one-line two-argument call. Carry only the original Lab's locator correction to the exact call name/open parenthesis; retain the existing authority-before-call comparison and the separate active-identity-before-argument check. No ordering gate or failure path is removed. The other original Lab runtime evidence additions remain in the remaining Lab.
