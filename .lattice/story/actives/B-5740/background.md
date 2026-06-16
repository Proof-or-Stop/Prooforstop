## Trigger Event
On 2026-06-16, during a pre-open-source cruft audit of the Lattice repo (after stories B-d313/B-0b26/B-08f2/B-747e), a stray tracked file 'orphans' (5 bytes, content 'NO -') was found at repo root, plus several unreferenced source modules. The user asked to delete the certain ones.

## Key Insights
'orphans' is a git-tracked shell-redirect mistake (a fragment of command output), pure junk that would ship. Three source modules are confirmed dead by a two-pass scan: their module basename appears in zero import statements across all .ts source, AND their exported symbols (intent-coverage: summarizeIntentCoverage/collectFixtureIntentRefs/IntentCoverageSummary/IntentCoverageMissing; phase-protocol: buildPhaseGateDecision/buildRollbackDecision/formatPhaseGateDecision; bridge-utils: the type CreateBridgeOptions) have zero external uses. The live 'verification intent coverage' and 'phase gate' behaviors are implemented elsewhere; these modules are superseded leftovers. verifier/dev-cli.ts was deliberately EXCLUDED because it is the `lattice serve` launcher (shebang + serve docstring) and its invocation path could not be confirmed dead.

## Solution Tradeoffs
Delete the 4 paths (1 junk file + 3 modules) and let the concept-deletion reviewer confirm no residual references and that the deleted modules' functionality is genuinely superseded (not the sole implementation of a needed feature). build + e2e must stay green. Conservative scope: only certain-dead items; dev-cli/omx/.codex/.lattice all deferred or kept.

## Conversational Texture
The user is driving the OSS launch and said 'delete the certain ones' after being shown the audit. They are handling the local git-branch/worktree cruft themselves separately, and asked for a recommendation (given) on experiments/lab and Story 3.
