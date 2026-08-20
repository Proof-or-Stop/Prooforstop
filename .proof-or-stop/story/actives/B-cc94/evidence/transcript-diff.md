# B-cc94 User-Value Transcript Diff

## Expected

Running the Proofbound CLI from the story worktree should show the runtime memory
pack at session entry. The pack must be bounded and advisory: it may remind the
host of relevant dev-memory and active playbooks, but it must not be presented as
review evidence, DONE evidence, or any other gate proof.

Expected visible signals:

- `Proofbound CLI 0.3.125`
- `## Memory Runtime Preflight`
- `authority=non_authoritative gateEvidence=false`
- `packDigest: ...`
- `render: maxLines=60 omittedCount=...`
- no claim that M5-M12 handoff/story/DONE/1M/health/rollout consumers are complete

## Actual Transcript

Commands run from `/Users/jek/Documents/Work/proofbound/.worktrees/B-cc94`:

```text
$ node packages/main/dist/cli.js --version
Proofbound CLI 0.3.125

$ node packages/main/dist/cli.js session_brief | sed -n '1,90p'
# lattice session brief

**Story**: B-cc94 — Implement Playbook Runtime Memory MVP1 for session consumption
**Phase**: TEST

## Memory Runtime Preflight
  authority=non_authoritative gateEvidence=false
  packDigest: d92896ce4c54cbeefc1969c9be3faf694d3d0916452252cc8a36e472cac9d511
  freshness: fresh
  sourceDigests: project=a4d414f479e9e55805dfbf9de700bfa2df2da46a9edb95b2a119f56d7ccc9988 global=889ac11e70324e9d28e316839b209a85edc8e1492050106cb1a8c24c6a59d9a6 playbooks=none signatures=ff960260a526eab3943ae201dbe232a09ffdb9942c633d4c7c05cf770e748e6b
  Dev-memory (5):
    - 9890b83 failure-mode/global: Old plan documents can mislead hosts after implementation is already DONE.
    - 7ffe281 workflow/project: Ordinary Proofbound/Lattice sessions should load dev-memory before coding.
    - ee3aef3 failure-mode/project: Proofbound review evidence must come from explicit reviewer lanes.
    - 148297b tool-quirk/project: Proofbound self-hosting CLI can lag until package dist is rebuilt.
    - 34e97f9 failure-mode/project: Proofbound reviewers must not take owner-gated lifecycle commands.
  suppressedSupersededIds: d6f173d
  render: maxLines=60 omittedCount=0
```

The same run also showed remaining lifecycle gate work as normal TEST/DONE
pre-check rows, which confirms the memory block is advisory context rather than
a DONE claim.

## Diff

No user-visible mismatch for MVP1. The expected session-entry memory pack appears
with digest, freshness, bounded rendering, and explicit non-authoritative /
non-gate wording. The output does not claim M5-M12 completion.

## Acceptance

Accepted for MVP1: session-entry runtime memory consumption is visible, bounded,
freshness-tagged, and explicitly non-authoritative.
