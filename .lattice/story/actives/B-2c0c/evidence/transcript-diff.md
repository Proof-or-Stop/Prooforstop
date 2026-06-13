# Transcript Diff

Story: B-2c0c

## Expected

When this branch changes direct decision documents under
`docs/requirements/decisions/*.md`, the local DONE gate should require a
structured host verdict quorum before completion:

- 3 distinct review rounds.
- At least 2 distinct PASSing hosts per round.
- Verdicts bound to the current decision-doc material digest.
- Prose-only review passes, duplicate hosts, duplicate rounds, stale digests,
  and non-pass decisions must not satisfy the quorum.

## Actual

`node packages/main/dist/cli.js decision_doc_quorum_check --storyId=B-2c0c`
reported:

```text
Decision-doc quorum: pass
  - materialDigest: 2cdbd05456e9596f0f7b20fe740fe2e6d945f26ffa944abcffd456817e23b82c
  - valid rounds: decision-doc-fresh-round-1(2 hosts), decision-doc-fresh-round-2(2 hosts), decision-doc-fresh-round-3(2 hosts)
```

`lattice validate --story=B-2c0c --json` reported:

```text
status: pass
allPass: true
Verification intent coverage: 12/12 covered
warnings: []
```

`lattice evidence_inspect --storyId=B-2c0c` reported:

```text
freshness: fresh
staleRefs: 0
authorityChanged: false
productionDone: false
```

## Diff

Expected and actual match. The gate is satisfied only by the fresh structured
host verdict quorum, while stale digest verdicts and prose-only review passes
remain ignored by the diagnostic output.
