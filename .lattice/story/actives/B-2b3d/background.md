## Trigger Event

Workstream 2 area 5 of docs/requirements/decisions/red-evidence-subsystem-spec.md, following B-9ff1
(W2d, section 1) which reached DONE on 2026-08-19. Section 0.1 states the gap this whole subsystem
closes: today a RED record only has to SELF-REPORT a non-empty observed failure, so nothing binds
whether the named acceptance target was actually exercised or whether the working tree was untouched
by the run. B-9ff1 made WHAT the run asserted machine-checkable. This leaf makes the RUN ITSELF
checkable.

## Key Insights

Section 2 defines a four-tuple captured immediately before the command starts and immediately after it
exits, and a run may produce a record only if all four compare byte-identical. Three of the four have
exact definitions the spec pins deliberately, each because an earlier revision got it wrong.

materialHash reuses the CLI's existing function verbatim - currentMaterialHash(gitCwd, ref='HEAD',
metadataRoot=gitCwd) in packages/main/src/core/evidence-freshness.ts - and the spec records that
earlier revisions drifted its parameter names. It is a COMMITTED-TREE hash and never binds dirty
worktree bytes; worktree-content equivalence is established separately by the material-dirt-empty
check, not by this hash.

indexState is EXACTLY the object id printed by `git write-tree`, recorded verbatim. The spec
explicitly retracts an earlier revision that called this equivalent to a SHA-256 over
`git ls-files --stage -z`: they are not equivalent, and the write-tree object id is the single
normative definition.

gitStatus is a SHA-256 over FILTERED, re-serialized `git status --porcelain=v1 -z` output, with a
byte-level parse rule the spec spells out because "removing lines" is undefined for NUL-delimited
rename records: entries whose XY code contains R or C consume TWO NUL-terminated path fields, all
others consume one, and an entry is excluded only if EVERY path field it carries matches an exclusion
glob - either side of a rename touching a non-excluded path keeps the entry.

The honest scope limit is normative and must survive into the implementation: this is NET-STATE
invariance. It proves the run's net effect on measured state is nil. It does NOT prove the command
performed no write at any instant, since a command could modify a tracked file and byte-restore it
before POST. The spec states that implementation stories MUST NOT describe the four-tuple as proof of
zero mid-run writes.

## Solution Tradeoffs

Mid-run write monitoring would close the residual gap but requires privileges or mechanisms the
isolation constraints exclude, so the claim stays at net-state and the risk is bounded structurally
instead: the workspace is disposable, so a self-restoring mid-run write cannot poison the real tree,
and the command is adapter-derived, so the attacker does not control the executable text.

The workspace is a detached git worktree under a fresh temporary directory, discarded unconditionally
whether the run passed or failed. That choice trades wall-clock (every run pays worktree creation and
a preparation step) for the property that no run can leave residue. B-9ff1's own history is the
argument for paying it: a command documented as writing nothing was found writing an activity-log row,
and only an explicit before/after content check caught it.

A decision this story must make rather than inherit: whether preparation commands run inside the
measured window or before PRE is captured. The spec puts prepare BEFORE the PRE snapshot and then
requires prep invariance separately, which means a prepare step that dirties the tree fails at PRE
rather than being silently absorbed into the invariance comparison.

## Conversational Texture

The four-tuple's three pinned definitions each carry an audit note recording what an earlier revision
got wrong. Whoever implements this should read those notes as test cases: an implementation that
computes indexState as a hash over ls-files output, or that filters gitStatus line-wise, or that
re-derives materialHash instead of calling the existing function, will look correct and be wrong in
exactly the way the spec already caught once.
