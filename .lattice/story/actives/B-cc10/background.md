## Trigger Event

Immediately after B-cdf6 merged to local main on 2026-08-17, the operator asked for three
follow-ups: remove the deprecated bin aliases, stop using the .lattice directory, and audit
what "lattice" identities remain. The audit answer was itself a correction: an earlier count
of "31 @lattice/core references" was scoped to packages/*/src and presented as a project
total. Re-measured at full-repo scope the number is 1006, of which 528 are frozen archives
under .lattice/, ~390 are node_modules, and only 4 package.json manifests plus their
lockfiles actually carry the npm identity. The operator caught that discrepancy directly.

## Key Insights

The load-bearing question was whether renaming these paths invalidates historical evidence.
It does not: the signature salts (lattice-finding-integrity-v1 and seven siblings) are
standalone string constants in core/finding-verify.ts and friends, independent of any
directory or filename, and .lattice/learning/ is explicitly materialHash-EXCLUDED. So the
salts can stay frozen as literals while the paths move.

The real weight is live state, not text: 7571 git-tracked files under .lattice/ covering 326
story archives. brand-rename-mapping.md:124 already classified the .lattice VALUE as frozen
precisely because "renaming in code orphans existing state" — this story overrides that
classification deliberately, with a migration, rather than by pretending the reason was wrong.

## Solution Tradeoffs

Option A, flag-day find-and-replace: fastest, but a half-completed run orphans 326 stories of
evidence with no reverse path. Rejected.

Option B, resolver-first then migrate: land a read-both path/filename resolver (extending the
additive core/brand-env.ts pattern B-cdf6 proved), route every literal through it, then git mv
the state so history follows, then rename the package, and only remove the bin aliases last
because that is the one irreversible break of the multi-developer compatibility guarantee.
Slower and more steps, but every intermediate state is a working repo. Chosen.

## Conversational Texture

The operator explicitly said not to consider the impact on other in-flight stories, which
removes the usual coordination constraint but not the evidence-preservation one — orphaning
archived stories would still destroy audit history that other work depends on. B-cdf6 also
supplied hard-won lessons worth carrying: a rename can break the CANONICAL name when a
hardcoded deprecated literal sits inside a comparison (four such regressions, all found by
reviewers, none by me), and one AST fingerprint had two coupled pinned copies where updating
only one failed closed.
