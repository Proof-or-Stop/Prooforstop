# B-8a1b real-machine verification — transcript & diff

Real-machine test of the tiny chore that closes the `koala init` no-churn
gitignore entrypoint drift, run 2026-05-20 in the B-8a1b worktree.

## Expected (CHK-001 userSees)

`npm run test:entrypoints` exits 0 with all checks passing; `npm test` exits 0;
`koala validate` exits 0.

## Actual transcript

1. The fix — diff is one Edit to `scripts/verify-entrypoints.mjs` only:

   ```
   const REQUIRED_RUNTIME_IGNORE_LINES = [
     '.koala/*',
     '!.koala/story/',
     '!.koala/story/**',
     '**/activity.jsonl',
     '**/owner-lease.json',     // <- added (B-c55d registry entry)
     '.koala/runtime/',
     '.koala/traces/',
     '.koala/locks/',           // <- added (B-f60c registry entry)
     '.koala-serve.json',
     '.koala-tmp-*',
     'koala-debug.log',
     'browser-test.log',
     '.omx/',
     '$PROJECT_ROOT/',
   ];
   ```

2. Live registry parity verified:

   ```
   $ node -e "import('./packages/main/dist/core/runtime-artifact-registry.js')
              .then(m => console.log(JSON.stringify(m.listRuntimeArtifactIgnorePatterns(),null,2)))"
   ```

   Output = 14 entries, byte-equal to the array above. `mergeKoalaRuntimeIgnores`
   now returns `changed=false` on the test's seeded `.gitignore`, so
   `koala init` takes the "runtime ignores already present" branch.

3. `npm run test:entrypoints` → `ok 25/25` + `entrypoints verified` (the
   specific assertion at `scripts/verify-entrypoints.mjs:555` that this story
   was opened to fix now passes; the byte-equality assert at :557 also passes).

4. `npm test` → `✓ ALL PASS` (story-lifecycle + gap-convergence end-to-end).

5. `koala validate --story=B-8a1b` → `✓ ALL PASS`;
   `Verification policy: express-exempt`.

## Diff (expected vs actual)

No differences. The pre-existing red light is closed; no other test, runtime
behavior, or runtime-artifact policy was touched. Only `scripts/verify-entrypoints.mjs`
changed; two array entries inserted at their canonical registry positions.
