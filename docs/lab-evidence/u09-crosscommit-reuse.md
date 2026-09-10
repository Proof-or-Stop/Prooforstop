# U-09 cross-commit validation reuse

The fixed Lab regression runs `node scripts/verify-crosscommit-joint.mjs`. RED at `f6c6192749` proves a clean descendant Git commit still executes all three commands despite an unchanged certified command. The temporary fixture first commits actual reviewer records, independently asserts clean status and ancestry, then compares the production full and incremental paths.

## Repair

Reusable command receipts now use schema v2. The executor records real before/after HEAD and dirty-status observations; a successful exit alone cannot create a clean-source receipt. Issuance requires both clean observations at the requested HEAD. Old v1 receipts are not grandfathered into the new rule.

Admissibility checks historical cleanliness against the receipt's own source HEAD, proves current HEAD/clean status separately, requires ancestry, and compares all certified tree entries between receipt source and current commit. Path, mode, type and object identity are retained, including directory/glob expansion and deletion. This additional receipt-relative comparison rejects the real counterexample in which the cumulative Story diff is empty after an input reverts to baseline. Git replacement references and custom replacement namespaces conservatively force execution.

Declared environment values use the executor's effective environment normalization, with explicit overrides, actual command cwd/PWD and distinct absent/empty values. Values are hashed, not emitted. The digest covers declared effective command environment, not a claim of complete operating-system isolation or atomic filesystem provenance. TEST/DONE and explicitly requested full validation continue to run the complete configured plan.

## Actual acceptance

- Same current material and Story hashes: full prompt 29,944 UTF-8 bytes; incremental 25,529, down 14.74%.
- Full executes `[build:0, affected:1, unaffected:0]`; incremental executes `[build:0, affected:1]` and reuses one receipt. Both catch the same injected JSON expectation defect; dynamic authority prerequisites pass.
- Actual source receipts: normal descendants reuse; revert-to-base executes; missing/tampered/contradictory provenance, nonancestor and dirty source refuse reuse. Preexisting dirty source can execute ordinary commands but issues no reusable clean receipt.
- Actual inherited environment changes A/B/absent/empty execute and issue distinct input receipts; repeated current values and unchanged explicit overlays reuse.
- Actual loose, packed and custom-namespace replacement refs reinterpret the same HEAD to different input bytes in a clean working tree; all refuse old receipt reuse. Removing replacement restores the positive control.
- Fourteen helper-level real Git/environment boundary assertions additionally cover directories, globs, modes, deletions and exact environment-key semantics. The test loader only exposes existing private helpers; it does not replace their algorithms.
- Build, process/runtime fact contracts, core dynamic smoke and final full-plan regression passed. Source/dist build binding: `0717ba288bd4:da5ef439c602` (source changes tested before the repair commit).

At the end of this cross-commit cycle, the standalone production shard smoke was separately unresolved: after repairing its retired fixture configuration filename, it reaches the original seven-receipt assertion but produces zero receipts because adapter registration rejects the current bytes. Its failure is preserved, not counted as a pass. The subsequent [shard adapter identity repair](u09-shard-adapter-identity.md) closes this failure with the original assertions retained. No formal Story DONE, full-suite/P95 claim or release is asserted here.

## Registered authority fault follow-up

The fixed follow-up RED at `adc894bddd` uses
`node scripts/lab/u09-paired-fault/module-pair.mjs`. It copies the actual scope
inventory validator at its canonical TypeScript source path, first proves the
healthy baseline, then changes the 4096-path limit to 1. Both full and scoped
children detected the same assertion failure, but the old scoped planner failed
to escalate and omitted the sentinel command. No protected-file override is used.

Runner v6 now classifies registered authority sources and the union of their
base/head dependencies. Independent review also reproduced aliased
`createRequire` and import-type omissions; both now have regression protection.
Opaque loader capabilities, unparsed sources and unresolved imports force full.
Graph identity includes the authority closure and policy.

All six predefined paired cases passed: dependency, actual policy, actual gate,
unmapped changed path, declared environment, and selector changes. The real Git
graph controls passed for helper changes, removed baseline edges, opaque imports,
type dependencies and an unrelated local source. The existing joint regression
still observes 29,944 versus 25,529 prompt bytes and retains command reuse while
catching the same injected defect; final full-plan regression also passed.

These are bounded fixtures. The registered closure in this actual repository has
unresolved external/dynamic imports and therefore falls back to full for ordinary
changes. No repository-wide incremental speedup or statistical miss-rate claim is
made. Restoring selective eligibility for those paths requires proof of dependency
resolution, not treating an unknown edge as absent.
