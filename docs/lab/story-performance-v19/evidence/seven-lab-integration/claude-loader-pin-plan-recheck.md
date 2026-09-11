## Verdict: **Approve** — update both pin sites to `52a283cf…905720`

All three corrections check out, and I verified the substantive basis independently rather than taking the proposal's word for it.

### Target hash confirmed (three independent ways)

| Method | Result |
|---|---|
| My own computation of the documented algorithm | `52a283cfcdc3bfbb233feab6d31614d0eabf8470a41d3af10ad7786246905720` |
| The guard's **own runtime output** on the failing run | `…sha256-v1=52a283cf…905720` |
| Proposal `candidate.fingerprint` | matches |

Algorithm reproduced from `retired-authority-vocabulary-guard-smoke.ts:868` — `ts.createPrinter({removeComments:true, newLine:LineFeed}).printFile(...)` → SHA256, ScriptKind.TS. TypeScript **5.9.3**, and both `origin/main`'s and the current lockfile pin 5.9.3, so toolchain skew is ruled out as a confound.

### The three corrections

**1. `pinnedBefore` is now accurate.** Both sites literally contain `b9eb52d0…f948f5` — `retired-authority-vocabulary-guard-smoke.ts:491` and `verify-process-fact-contract.mjs:2447`. Exactly two occurrences repo-wide (excluding `node_modules`/`dist`). The `earlierCandidateMeasurement` (`98155111…`) is correctly segregated out of the pin lineage.

**2. Pre-existing main drift is real, not a framing device.** `git show origin/main:packages/main/src/cli-engine.ts` fingerprints to `b4f27e9ad02f24b951410ce452089ac0e73da21df2b576896c9242479c204e64` — matching the proposal's `main.fingerprint` exactly — while origin/main pins `b9eb52d0` in both sites. Same TS version on both sides, so origin/main (`d354d2b43d`) genuinely ships a stale pin and its own guard would fail. This branch is not the cause.

**3. The wrapper/anchor and whole-file-only limits are stated correctly.** I verified the anchor claim empirically rather than by reading `enclosingFunctionName` alone. The diff wraps runCli's body in `return withValidationSigningRoot(root0, async () => {…})`, so both `import()` calls now sit inside an arrow. Resolved parent chain:

```
AwaitExpression → ExpressionStatement → Block → IfStatement → Block
  → ArrowFunction → CallExpression → ReturnStatement → Block → FunctionDeclaration
```

`enclosingFunctionName` returns only on `ts.isFunctionDeclaration`, so it walks past the `ArrowFunction` and resolves **`runCli`** for both calls. Anchor preserved.

The "whole-file-only" caveat is also correct: the provenance-pin map (`rootIdentifier`/`producer`) holds exactly two entries — `handlers/graph.ts` and `prompt-full-context-envelope-smoke.ts` — and no cli-engine entry. Declining to claim a graph-based control is the honest reading.

### Substantive re-approval basis holds

Dynamic-load surface is byte-identical across main and current: exactly two dynamic imports (`` await import(`file://${initPath}`) `` and `await import('./dashboard.js')`) plus one type-only `import()` annotation; zero `eval` / `new Function` / `vm` / `runInNewContext` / `require()` / `createRequire` on either side. The `initPath` producer line is unchanged. Only line numbers moved (895→897, 907→909). The digest moved because the algorithm fingerprints the whole enclosing file — as the existing comment history says.

**Scope is genuinely bounded.** I checked every entry in both fingerprint maps: cli-engine.ts is the only drift. The other 6 `PINNED_EXECUTABLE_SOURCE_FINGERPRINTS` entries and all 8 `DYNAMIC_CODE_GENERATION_FINGERPRINT_EXEMPTIONS` entries match their pins.

The two-site coupling is confirmed mechanically: `verify-process-fact-contract.mjs:2366` reads the guard's source text and asserts the hash as a required substring token, so both must move in the same commit.

### Conditions on the approval

1. **Approving this pin is not approving the wrapper's behavior change.** The `withValidationSigningRoot` wrapper also rewrites failure classification and exit codes (`commandSucceeded`, `topLevelValidationFailed`). The pin attests only that the dynamic-load surface is unchanged — which it is. Those behavioral diffs need their own review.
2. **The guard fails fast**, so assertions after `assertLegacyDeliveryCompatibilityPositiveControls` are unobserved. Confirm a full green `npm run test:retired-authority-vocabulary-guard` **and** `npm run test:process-fact-contract` after the edit — the pin being correct doesn't prove the rest of the guard passes.
3. **Rebuild before re-running**: the guard executes from `dist/`, so the `.ts` edit needs `npm --prefix packages/main run build` to take effect. The verifier `.mjs` reads `.ts` directly and does not.
4. **Record the measured basis in the comment** — `origin/main d354d2b43d` measured at `b4f27e9a`, pin was stale at `b9eb52d0`, new value `52a283cf` measured on this branch's source. If main touches cli-engine.ts again before merge, the pin must be re-measured at merge time rather than carried forward.
5. Describe `earlierCandidateMeasurement` as a **superseded measurement**, not corroboration — it corresponds to a cli-engine.ts state not reachable in the worktree or on origin/main, so it is provenance only.

No files were edited; all checks were read-only.
