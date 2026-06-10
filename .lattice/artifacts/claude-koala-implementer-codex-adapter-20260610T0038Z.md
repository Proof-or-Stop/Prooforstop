# Claude CLI Implementer Artifact: Codex Adapter Repair

## Original user task

Execute the Baseline 2-5 parallel-development readiness audit, with the main agent acting as auditor and host/agent lanes used for implementation and review. Apply only real correctness fixes, avoid arbitrary optimization, and preserve logical consistency.

## Final prompts sent to Claude CLI

### Prompt 1: Codex native hook

You are the Lattice koala-implementer for story B-688d. Work in the current git worktree only. Minimal task: fix the Codex native PreToolUse hook correctness blocker. Create or update only .codex/hooks/lattice-scope-pretool.cjs using the repository canonical renderCodexPretoolScopeHookScript template from packages/main/src/init-assets.ts. Do not edit docs/story or tests/fixtures. Do not change audit artifacts. Do not commit. After editing, run git diff -- .codex/hooks .Codex/hooks and node bin/lattice.js verify_codex if available; report changed files and command output summary. If .codex and .Codex alias on this filesystem, still write the official lowercase path.

### Prompt 2: Codex manifest drift

You are the Lattice koala-implementer for story B-688d. Work in the current git worktree only. Minimal task: fix the Codex manifest drift reported by node bin/lattice.js verify_codex. Update only .Codex/lattice.json (same file as .codex/lattice.json on this filesystem) so it exactly matches the repository canonical renderLatticeCodexAdapterManifest() output from packages/main/src/init-assets.ts / packages/main/dist/init-assets.js for full asset mode. Do not edit docs/story or tests/fixtures. Do not change audit artifacts. Do not commit. After editing, run node bin/lattice.js verify_codex and report changed files plus whether Codex manifest and native hook pass.

## Claude output (raw)

### Output 1

Done. Here's the summary:

**Changed files:**
- Created `.codex/hooks/lattice-scope-pretool.cjs` (new file, untracked) -- written from the canonical `renderCodexPretoolScopeHookScript()` template in `packages/main/src/init-assets.ts`

**Filesystem note:** `.codex` and `.Codex` share the same inode (case-insensitive macOS filesystem), so git shows it as `.Codex/hooks/`. The hook script is at the official lowercase path.

**`hooks.json`** already existed at `.codex/hooks.json` with the correct matcher (`apply_patch|Edit|Write`) and command pointing to `.codex/hooks/lattice-scope-pretool.cjs` -- no changes needed there.

**`verify_codex` output:** Blocked by story owner lease (`sess-97b4ba107b298439` owns B-688d; this session is `sess-e65e067251d6e974`). This is expected -- the parent session holds the lease. The command itself is reachable; the blocker is ownership, not a missing asset.

### Output 2

`verify_codex` is blocked by session ownership (another session owns B-688d). However, the content comparison confirms the fix is correct.

**Changed file:** `.Codex/lattice.json`

**Diffs from old -> new:**
1. Removed the `"global-codex"` entrypoint (not in canonical manifest)
2. `"local-wrapper"` useWhen changed from custom text to canonical `"This repository includes the Lattice bootstrap wrapper."`
3. `excludedRuntimeAssets` removed `".Codex/hooks"` (canonical only has `".Codex/settings.json"`)
4. Added missing note about native hooks (`"Codex native hooks are official lowercase .codex assets..."`)
5. Fixed verify command note from `"Run lattice codex verify"` to `"Run node bin/lattice-codex.js verify_codex"`

**Codex manifest:** PASS (byte-exact match against `renderLatticeCodexAdapterManifest()` output).
**Native hook:** Cannot verify via `verify_codex` due to session ownership lock -- the owning session (sess-97b4ba107b298439) must run it, or it can be run with `--forceTakeover`.

## Auditor verification

The main auditor did not accept Claude's self-report as sufficient evidence. The owner session independently ran:

```text
node bin/lattice.js verify_codex
```

Observed result:

```text
✓ Codex adapter checks passed (7/8 pass)
  [✓] Codex manifest: .Codex/lattice.json matches Lattice legacy template
  [✓] Codex agents mirror: 16 prompt(s) mirrored
  [✓] Codex runtime exclusions: no uppercase-only .Codex/hooks or .Codex/settings.json
  [✓] Codex native PreToolUse hook: .codex/hooks.json wires apply_patch/Edit/Write to lattice-scope-pretool.cjs
  [✓] Local Codex wrapper: bin/lattice-codex.js sets Codex activity env
  [✓] Local wrapper heartbeat: source=codex session=codex-check-local-1781048277152 entrypoint=local-wrapper
  [!] Global fallback heartbeat: global @koala-agent/core resolves to another worktree; treat global koala as heartbeat-only, not current-worktree gate/status evidence
  [✓] Aux command availability: aux_doc_list registered
```

## Concise summary

Two real adapter correctness gaps were repaired:

- The Codex native PreToolUse hook script now exists at the official lowercase `.codex/hooks/lattice-scope-pretool.cjs` path.
- `.Codex/lattice.json` now matches the canonical Lattice Codex adapter manifest.

No baseline audit conclusion was changed by these repairs. They only restore the Codex adapter evidence gate needed before the story can proceed.

## Action items / next steps

- Commit the Codex adapter repair and this artifact.
- Refresh stale verification evidence caused by the adapter material change.
- Re-run REVIEW and TEST before writing delivery check and summary.
