# B-2856 Execution Plan

Bug: ~14 git child-process sites default cwd to metadataRoot/projectRoot instead
of the configured gitRoot, breaking wrapper-root layouts. Reuse the existing
`resolveStorySignedWorkspace()` (authoritativeCwd = resolved gitRoot); reroute
consumers; null-fallback to projectRoot so plain repos stay byte-identical.
cwd-only — no git command text, gate semantics, or bootstrap change.

## Approach
At each handler entry, resolve `authoritativeCwd` via `resolveStorySignedWorkspace()`
and thread it (replacing projectRoot/root) into the readers and worktree git
call sites via the existing dependency-injection seams. When the resolver returns
null/unresolved, fall back to the current projectRoot.

## Checklist order & dependencies
1. **CHK-005 first (foundation):** confirm/expose the resolver's authoritativeCwd
   helper + a single `resolveGitCwd(storyCtx) -> authoritativeCwd ?? projectRoot`
   fallback helper, and stand up the `gitroot-cwd-routing-smoke` test harness
   (wrapper-root fixture: metadataRoot not a git repo + gitRoot subdir; plain-repo
   fixture). Tests assert the *cwd* each git op uses, not just success.
2. **CHK-001:** route validate-channel.ts git readers through resolved gitRoot.
3. **CHK-002:** route validate-concept.ts git diff + repo grep through resolved gitRoot.
4. **CHK-003:** route cluster-sync.ts `readCommitsSinceMain` git log through resolved gitRoot.
5. **CHK-004:** route handlers/worktree.ts story_discard + story_advance merge +
   remove/branchExists git()/execFileSync sites through resolved gitRoot.

(Items 2-5 each: enumerate the file's git sites by grepping `cwd:`/`projectRoot`/
`root`/`execFileSync('git'`/`git(`, reroute each, extend the smoke to cover it.)

## Verification
- `gitroot-cwd-routing-smoke`: wrapper-root fixture -> each rerouted op runs in the
  gitRoot subdir and succeeds; plain-repo fixture -> each op runs in projectRoot
  (byte-identical). Include a negative: resolver-null -> projectRoot fallback.
- `npm --prefix packages/main run build`; `node bin/lattice.js validate --story=B-2856`.

## Out of scope
- Bugs 2/3/4 from the ClawCreek report (atomic bootstrap; .lattice track/ignore
  data-loss; lint change-scope) — separate stories.
- Any git command-text / gate-semantics / bootstrap change; any new resolver.
