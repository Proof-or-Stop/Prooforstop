# Intake history repair in the existing consolidated Lab

The user authorized bounded RED/GREEN repair of the verified intake-discovery overhead and obsolete tree-failure witness. This work remains in Lab-memory-intake-measurement. No second Lab, main integration, release or remote push is performed. The previous Memory timing and scanner AST repairs remain included in the pinned regression command.

## Changes

Workspace resolution now exposes the existing authoritative resolver's successful worktree observation to the same caller. It avoids a second inventory solely to reconstruct the same worktree path. There is no process-wide, cross-command, or moving-state cache. A persisted worktree without an inventory still uses the normal inventory reader. Failed inventories are not observations of absence: the historical fallback/retry remains. A stale registered path still appears in the informational worktreePath field while authoritative gitCwd falls back as before. Terminal phases still perform zero Git work. The existing resolveGitCwd string API delegates to the same resolver and retains its fallback.

Baseline selection reads absolute Git/common directories together and retains independent probes when newline-containing paths make framing ambiguous. merge-base already validates commit eligibility, so its immediately preceding duplicate rev-parse verification is removed in the uncached candidate loop. Remote/main movement, ordinary versus linked checkout ordering, local containment and explicit snapshot-cache policy are preserved. No moving reference result is memoized.

The tree safety test now distinguishes a valid warm immutable cache hit from a cold read failure. It creates a new commit before cold injection, requires the injected ls-tree to run, checks material-hash refusal and structured ENOBUFS propagation from changed-files, then verifies retry success after restoring Git. The old generic error-message assertion did not match the current error propagation; no product exception behavior was changed to make that test pass.

## RED and GREEN

Managed RED was recorded at 082ea1d962 with `node scripts/lab/verify-intake-history.mjs`, requiring INTAKE_DISCOVERY_RED. The reproduction ran all controls, then failed on 40 inventories versus a 20 limit and 120 baseline commands versus an 80 limit. The old safety test independently failed. [Recorded command output](managed-red.json).

A supplemental failed transient-inventory witness was captured before repairing retry semantics: [failure](transient-inventory-red.log). It failed on the premature reuse of absence. The final discovery test covers this path, stale-path display, worktree add/remove, persisted binding, terminal phases, wrapper-root configuration, ref movement, malformed blob refs, zero-command expired deadlines and newline-containing repository paths.

The pinned command rebuilds/validates current dist, runs discovery, tree safety, local-baseline policy controls, workspace health comparison, 92 hash invalidation comparisons, Git-root memo controls, Git tree batching and HEAD-drift controls, plus the previous Memory/scanner consolidated checks. GREEN is recorded by the managed CLI against the final committed candidate; its authoritative record remains under the Git common lab-maintenance directory. A read-only export of the final record is supplied with delivery outside the worktree, avoiding a self-referential evidence commit.

## Controlled performance comparison

One unchanged 50-file temporary repository, fresh child processes, 20 calls per function, before/after/after/before. Before loads the four actual pre-repair discovery modules from 082ea1d962; after uses the current built modules. Other dependencies are identical. Timing starts after imports. This is a bounded module replay, not a historical full-CLI timing. Full source/dist binding is verified before and after, fixture HEAD remains fixed, and all 80 hashes plus all workspace/baseline result fields compare equal. Candidate source was committed at c276720674633da87b0dfc81617990749ad8d5de.

| Operation (20 calls) | Before mean ms | After mean ms | Reduction | Deterministic count |
|---|---:|---:|---:|---|
| Workspace resolution | 605.425 | 404.889 | 33.12% | Worktree inventory 40 → 20; total Git 60 → 40 |
| Story hash | 1500.004 | 1127.564 | 24.83% | Total Git 149 → 109; tree and diff remain one each |
| Baseline selection | 1181.438 | 820.228 | 30.57% | Total Git 120 → 80 |
| Tree failure witness, each SHA format | Warm hit, zero injected calls; test fails | Cold material/changed-files calls trigger two failures; refusal and retry pass | Correctness repair | SHA-1 and SHA-256 |
| Existing root memo | Six queries / one probe | Six queries / one probe | Preserved | Nested-root add/remove invalidates correctly |
| Existing scanner AST reuse | Historical unoptimized 368 parses | 234 parses | Preserved | Full strict scanner reports equal |

[Raw four rounds, values, loaded-module hashes and build bindings](abba.json); [summary](summary.json). Run `node scripts/lab/measure-intake-history.mjs /absolute/output.json` to replay. The 50% inventory reduction applies to this no-binding workspace fixture, not all session_brief scans. Wall times reflect this host and small sample; command counts are the acceptance thresholds. Do not add baseline timing savings to hash savings because baseline is nested within hash.

JSON was not shown to be a primary bottleneck (prior observed session_brief JSON totals 51–65ms); no speculative general JSON cache or fake RED was introduced. This change also makes no new claim about Memory cold-path population frequency or eliminating its legitimate overflow fallbacks.

## Repository health and scanner evidence binding

The complete single-owner-extraction smoke was additionally run on current main and the candidate: both report exactly 38/40 passes and the same two failures. The structural check rejects an existing loadConfig call in validation-plan.ts; the output bound observes 11252 characters against 11000. The changed workspace cases pass. These pre-existing failures are outside this discovery repair and are NOT labelled full-suite GREEN. Raw [main](workspace-main.log) and [candidate](workspace-candidate.log) outputs and [baseline identity](workspace-health-baseline.json) are retained. The bounded health wrapper requires all 40 cases to complete, permits only the exact reproduced failures, and rejects any new failure; it prints NO_NEW_REGRESSIONS with the remaining failures explicitly. Follow-up remains with the B-41c8 single-owner extraction verification surface; this report does not close that Story or invent signed Finding disposition.

The first GREEN attempt exposed a stale scanner exception dependency digest caused by changing the structural assertion to require the shared observation helper. Review confirmed that single-owner-extraction still imports/calls only entriesFromSerialReference, not the full-suite executor. Only EX-0178's digest for that one task file was rebound; its command, call digest, source excerpt, permitted indexes, kind and all other dependency bindings remain unchanged. This covers four configured caller rows without adding an exception or suppressing scanner review.

All records here are local maintenance evidence. The older independent vendor audit applies to the earlier consolidated head, not this new repair. A fresh independent audit is required before any later requested integration.
