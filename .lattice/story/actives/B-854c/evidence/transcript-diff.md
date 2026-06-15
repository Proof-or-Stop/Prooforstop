# B-854c real-machine verification transcript + diff

Verified against the worktree's freshly-built dist (`packages/main/dist/cli.js`), NOT the
stale global `lattice` symlink (which lacks this story's code). All commands run from temp
git repos with hand-written `.gitignore` fixtures.

## Expected (PLAN outcome) vs Actual

### 1. Bootstrap force-add on a project that ignores `.lattice` (the previously-failing path)

Expected: bootstrap no longer prints `The following paths are ignored by one of your .gitignore
files: .lattice`; instead it force-adds so the metadata is staged/committed.

Actual:
```
=== OLD behavior (git add without -f) on ignored path ===
The following paths are ignored by one of your .gitignore files:
.lattice
OLD exit: 1 (1 = hard fail, the bug)
=== NEW behavior (git add -f) — what bootstrap now does ===
NEW exit: 0 (0 = succeeds, metadata staged)
.lattice/story/actives/B-boot/index.json   <- staged
```
Diff: MATCH. Old path hard-fails (exit 1); new force-add path succeeds (exit 0) and stages the
metadata leaf.

### 2. Bootstrap data-loss warning text (broad-ignore case)

Expected: a loud warning pointing at `lattice doctor --repair`.

Actual (rendered by the shared `renderStoryMetadataProtectionWarning`, the exact text dev_start appends):
```
⚠ DATA-LOSS RISK: story metadata is ignored by .gitignore and is NOT git-tracked.
      leaf: .lattice/story/actives/B-boot/index.json
      A broad `.lattice/` ignore leaves this metadata neither tracked nor protected;
      a later `git clean -fdx` or a wrong-branch checkout can PERMANENTLY delete it
      (this is exactly how ClawCreek lost 19 stories).
      → Run `lattice doctor --repair` to install the managed ignore-volatile/track-metadata
        allowlist so story metadata stays tracked while runtime stays ignored.
```
Diff: MATCH.

### 3. `lattice doctor` on a project where metadata is neither tracked nor protected

Expected: `✗ story metadata is neither git-tracked nor protected by the managed ignore allowlist`
with a repair pointer; `--json` marks the invariant unsafe.

Actual (text):
```
Story metadata protection scan:
  ✗ story metadata is neither git-tracked nor protected by the managed ignore allowlist
      B-demo: .lattice/story/actives/B-demo/index.json (ignored=true, tracked=false)
      A later `git clean -fdx` or wrong-branch checkout can PERMANENTLY delete this metadata
      (this is exactly how ClawCreek lost 19 stories).
  - managed ignore allowlist not fully installed (missing 24 pattern(s))
  → lattice doctor --repair to install the managed allowlist ...
```
Actual (`--json` `storyMetadataProtection`): `evaluated:true, unsafe:true, leaves:[{storyId:"B-demo",
leaf:".lattice/story/actives/B-demo/index.json", tracked:false, ignored:true, unsafe:true}]`.
Diff: MATCH.

### 4. `lattice doctor --repair` installs the allowlist; re-scan reports safe; idempotent

Expected: `--repair` writes the managed allowlist so a re-scan reports safe; second run a no-op.

Actual (text after repair):
```
Story metadata protection scan:
  ✓ story metadata is tracked or protected (1 active leaf/leaves checked)
  ✓ installed managed ignore-volatile/track-metadata allowlist in .gitignore
  → `lattice doctor --repair` will be a no-op now; commit the .gitignore change, then `git add` + commit story metadata.
```
Actual `.gitignore` after repair: the conflicting bare `.lattice/` line was neutralized
(`# .lattice/ # superseded by lattice managed allowlist (lattice doctor --repair)`) and the
managed `# lattice runtime artifacts (managed)` block (with `!.lattice/story/actives/**` negation)
was appended.
Actual re-scan: `unsafe after repair: false | needsRepair: false`; `git check-ignore` on the leaf
now exits 1 (not ignored = SAFE).
Diff: MATCH.

## 5-question user-value self-check
1. Can I imagine the moment of doneness? Yes — an operator on a misconfigured (ClawCreek-style)
   project runs `lattice doctor`, sees the ✗ data-loss warning, runs `--repair`, and the next
   scan is green; bootstrap no longer hard-fails on an ignored `.lattice`.
2. Is the output concrete text, not an abstraction? Yes — exact strings captured above.
3. Does it match what PLAN promised? Yes — all four scenarios MATCH.
4. Edge cases covered? Yes — negation-allowlist (safe, no false positive), tracked leaf (safe),
   empty leaf (rejected), bare `.lattice` vs `.lattice/` both neutralized, idempotent repair.
5. Anything unresolved? No open findings; both REVIEW rounds passed; CLI gates all pass.
