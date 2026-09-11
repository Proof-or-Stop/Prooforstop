## REQUEST_CHANGES

The **target value is correct and the repin is substantively safe** — the changes I'm asking for are to the approval record, not to the number.

### What I verified (passes)

**No new dynamic-loading authority.** `cli-engine.ts` has exactly two dynamic loads on both sides, unchanged:

| | main | HEAD |
|---|---|---|
| `const initPath = new URL('./cli-init.js', import.meta.url).pathname.replace(...)` | 891 | 896 |
| `await import(\`file://${initPath}\`)` | 892 | 897 |
| `await import('./dashboard.js')` | 904 | 909 |

Byte-identical producer and argument. No new `import()` / `require()` / `eval` / `new Function` / `createRequire`. The four new imports (`withValidationSigningRoot`, `projectControllerAssetsIntoStoryWorktree`, `resolveAgentMutationAuthority`, `AgentDispatchMutationCommand`) are all static with literal specifiers. `initPath` still derives solely from `import.meta.url` — not from `root0`, cwd, argv, or env — so the branch's new `root = process.cwd()` switch cannot reach the loader target.

**The candidate value is real, and measured on this exact tree.** `merged-seven-baseline.log:10-13` records `FAIL retired-authority-loader-provenance` → `packages/main/src/cli-engine.ts`, line **897**, `unapproved non-literal dynamic module load`, `...sha256-v1=52a283cf...`, with a stack path inside this worktree's `dist`. That `actual` array has exactly **one** element, so the whole-repo scan found no other unapproved load anywhere on this branch. (I could not recompute the digest myself — `node` execution wasn't permitted here — so this rests on the guard's own recorded output.)

**Anchor control survives, without widening.** The loader call now sits inside a new `withValidationSigningRoot(root0, async () => {...})` arrow wrapper opened at `cli-engine.ts:819`. `enclosingFunctionName` (`retired-authority-vocabulary-guard-smoke.ts:1850-1856`) matches only `ts.isFunctionDeclaration`, skipping arrows, so it still resolves to `runCli` and the allowlist entry at :1666 still matches. Arrows nested in `runCli` already satisfied that predicate, so the qualifying set did not grow.

**Both coupled pins exist and are exactly two**, both currently `b9eb52d0...`: `retired-authority-vocabulary-guard-smoke.ts:491` and `verify-process-fact-contract.mjs:2447`. Mutation controls still bite — the whole-file pin stays unconditional (:876-891) and `isKnownBenignNonLiteralLoaderCall` (:2128-2147) still requires fingerprint **and** anchor **and** argument text **and** provenance.

### Why I'm not approving the record

**1. `prior` is not the pinned value.** `98155111...` is an earlier measurement from this same campaign (`seven-integrated-1.log:13`, 15:39), not what either file pins. The actual pinned value `b9eb52d0...` appears nowhere in the proposal. An applier keyed on `prior` gets zero hits and falls back to hand-editing — which is precisely how B-cdf6:F-057 got one copy updated and the other left stale.

**2. `main: b4f27e9a...` has no receipt.** It appears nowhere in the evidence directory, and I could not verify it against main's blob. If it's accurate, main's own pin is already stale and this repin is also repairing pre-existing main-side drift — a materially different claim that must be disclosed. If it's not accurate, it's an unsupported number in an approval artifact.

**3. The schema is blind to the only structural change near the loader.** `calls` / `initPath` / `fingerprint` would read identically whether or not the `withValidationSigningRoot` wrapper had been added. Every prior repin in that file records what moved and why; this one records nothing about the wrapper, so a reviewer reading only the proposal would never learn the call site's enclosing context changed — the exact class of change the anchor control exists for.

### To approve

Restate `prior` as `b9eb52d0027...` (the value actually in both files), substantiate or drop `b4f27e9a`, and add the re-approval basis naming the wrapper — that the loader moved inside a new arrow at :819, that `enclosingFunctionName` skips arrows so `runCli` still resolves, and that producer and argument are byte-identical to main. Then update both sites in one commit.

One thing outside this repin's scope, flagged for the record: `cli-engine.ts` has no `APPROVED_LOADER_ARGUMENT_PROVENANCE` entry, so the producer-rebind control does not bite for it — the whole-file fingerprint is the only thing guarding that call site. Pre-existing, not introduced here, but the graph.ts note at :1750-1755 argues coarse anchors are exactly why those pins exist.
