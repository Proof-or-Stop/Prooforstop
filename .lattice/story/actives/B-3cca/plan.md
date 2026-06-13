# B-3cca Execution Plan

## CHK-001

Audit `packages/main/src/cli-engine.ts` before editing. Treat `packages/main/dist/cli-engine.js` as generated output. Classify every `Koala`, `koala`, and `@koala` hit into one of three buckets: current-product wording to rename, legacy compatibility token to preserve, or process-contract reviewer lane to preserve. The expected audit output is `cli-engine branding audit: PASS src unclassified=0 dist unclassified=0` after implementation and build.

## CHK-002

Use the Claude CLI agent in the B-3cca worktree for the implementation pass. Change current-product comments, descriptions, help text, diagnostics, commit-message prefixes, stale-state warnings, and hook log prefixes to Lattice wording. Preserve exact compatibility identifiers: `koala` CLI alias, `koala.config.json`, `.koala` legacy story path, `koala-codex`, and `koala-review-*` process lanes. Any remaining user-visible Koala wording must explicitly say legacy alias, legacy fallback, or process lane.

## CHK-003

Add a focused branding smoke under `packages/main/src/tasks/cli-engine-branding-smoke.ts` and expose it through `packages/main/package.json`. The smoke must scan both source and generated dist output and fail on unclassified Koala branding. Run `npm --prefix packages/main run build` to regenerate `dist/cli-engine.js`, then run the smoke plus process/entrypoint checks.

## CHK-004

Capture the Claude CLI invocation/session summary as verification evidence. The evidence must state the implementation ran in `/Users/jek/Documents/Work/Orchestrate/.worktrees/B-3cca`, summarize what Claude changed, and confirm Codex reviewed the resulting git diff before committing. Completion is not valid if only the main agent edited the files.
