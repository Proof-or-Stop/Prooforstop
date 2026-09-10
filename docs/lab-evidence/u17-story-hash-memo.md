# U17 Story hash memo acceptance

The original Story-hash path performed two merge-base queries, one tree read,
and one diff for every call. Its committed RED witness made three identical
calls and observed six merge-base queries, three trees, and three diffs.

The repair resolves the merge base once and reuses unfiltered immutable Git
tree/diff bytes. Moving refs are resolved on every call. Configuration,
attribute candidates, index, Git discovery, and executable identity remain
dependencies; their bounded filesystem content identities avoid repeating
unchanged config/attribute subprocess probes. Effective attributes, unknown
configuration, unsupported discovery, split indexes, alternates, replacement
refs, or unsafe routing use authoritative reads. The final policy-filtered hash
is never cached. Configuration changes follow the existing explicit
`resetConfigCache()` reload contract.

The fixed regression plus 92 cold-process/repeated-call comparisons passed,
including main/origin movement at unchanged HEAD, HEAD changes, rename/delete,
configuration reload, global and indexed attributes, symlink changes, split
index/alternates, replacement namespaces, nested repositories, executable
changes through relative PATH, and worktree recreation. Existing material and
Git-root memo regressions also passed.

## Controlled comparison

One unchanged 50-file temporary repository; 20 public function calls per fresh
process; new/old/old/new. Old mode loads the actual two pre-repair modules from
`3f010a95b24c73d68fa6df0fc715df102f9ea4f0`. New mode uses the actual built modules
without loader replacement. All 80 returned hashes are byte-identical.

| Mode | Function-call time (ms) | Git calls | Tree reads | Diffs |
|---|---:|---:|---:|---:|
| New | 576.134 | 49 | 1 | 1 |
| Old | 934.760 | 80 | 20 | 20 |
| Old | 917.140 | 80 | 20 | 20 |
| New | 588.015 | 49 | 1 | 1 |

Mean function-call time decreased 37.14% in this fixture. Timing begins after
imports; historical TypeScript-loading overhead is excluded. Full source/dist
bindings were checked before and after. The working-tree repair was measured
before its commit, so the recorded repository HEAD alone does not describe the
new implementation; the recorded build digests bind those exact bytes.

[Raw results and bindings](u17-story-hash-raw/results.json).

```sh
node scripts/verify-story-hash-memo.mjs
node scripts/lab/u17-story-micro-abba.mjs
```

This closes the omitted Story-hash memo and its bounded performance witness.
The original expensive quorum target's combined-memo A/B remains separate;
these measurements are neither whole-suite nor population/P95 results.
