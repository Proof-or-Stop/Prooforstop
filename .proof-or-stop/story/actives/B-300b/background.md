## Trigger Event

During B-137a (2026-09-07) the managed reviewer lanes were re-run roughly fifteen times before quorum could hold. Six of those rounds were lost not to real defects in the story under review, but to gates rejecting a reviewer for violating an invariant that no prompt anywhere states. F-299 was found in the same sweep and is the code-side sibling of that class.

## Key Insights

Each gap has the identical shape: a gate mechanically enforces an exact rule, the reviewer-facing protocol describes a weaker or different rule, and the mismatch is only discovered after a full review has already run and been discarded. Concretely: readCount was documented as "integer" while the gate requires it to equal the unique filesReadFully count; the routing digests had to be copied verbatim from candidate-spec-set.json but the protocol only asked for a "truthful readManifest"; the manifest and log file lists must be identical sets, unstated; the final proposal must be emitted exactly once, while the protocol constrained only the content of one result, so a reviewer submitting twice was refused after finishing; manifest paths must be repository-relative, with absolute scratch paths refused silently. F-299 is the same failure in code rather than prose: readManagedHostRunBinding trusts archive.binding after only a runId check while its sibling import-seal reader re-digests it, so the protection already exists in the file and one reader simply skips it.

## Solution Tradeoffs

The fix must land on the prompt side, never by relaxing a gate: every one of these gates is enforcing something real, and loosening it would let genuinely bad evidence through. The alternative considered and rejected was leaving the gaps and documenting them in CLAUDE.md, which does not help because a reviewer never reads CLAUDE.md. Regression coverage matters more than the prompt text itself, since a future prompt edit can silently drop a line and reintroduce a whole wasted round; the process-fact contract test is the natural place to pin prompt-and-gate agreement. F-299 is bounded differently: it needs the archive reader to reuse the digest check that already exists twenty lines away, plus a forged-binding smoke case.

## Conversational Texture

The user asked which of three remaining options best fits the repository's own practice. Two of the three required either a multi-hour signed acceptance campaign or a critic pass that cannot be authored by the same agent it is meant to check. This one is the only option the Defect triage discipline actually prescribes: framework-wide defects that are not regressions of the current story's acceptance scope get recorded with evidence and routed to a named follow-up, rather than widening the current story to chase all-green.

## Dependency on B-137a (INIT-001)

Every source location this story cites lives in `packages/main/src/core/managed-host-run.ts` and `managed-review-evidence.ts`, and those modules exist ONLY on the unmerged `story/B-137a` branch. On `main` they are absent entirely; the pre-split equivalent is `packages/main/src/core/host-run.ts`, which contains no `readManagedHostRunBinding` (verified: zero matches across `packages/main/src/core` on main). A worktree cut from `main` per the documented lifecycle therefore cannot locate any of the cited code, which is what the INIT reviewer flagged. This story must not enter DEV until B-137a merges to main, and the cited line numbers must then be re-resolved by symbol name because they will have shifted. B-137a itself is currently held in REVIEW by two structural gate blockers that require a re-run acceptance campaign, so this dependency is not a short wait.
