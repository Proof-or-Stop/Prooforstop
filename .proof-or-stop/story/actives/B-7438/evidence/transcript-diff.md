# B-7438 User Value Acceptance Transcript

Date: 2026-07-09
Worktree: `/Users/jek/Documents/Work/proofbound/.worktrees/B-7438`

## Expected

When a host tries to justify degraded 3x1 review fallback with
`eligibility=single-host-environment`, the framework must first use fresh
canonical host availability evidence. If at least two canonical hosts are
available, the fallback must be refused instead of relying on agent prose.

Canonical hosts checked by this story: `codex`, `claude`, `agy`.

## Actual Transcript

Command:

```bash
node packages/main/dist/cli.js review_host_availability_probe \
  --storyId=B-7438 \
  --actor=main-agent \
  --json \
  --forceTakeover > /tmp/B-7438-user-value-probe.json
```

Observed summary:

```text
probeId: B-7438:RHP-mrdh19fw
availableHostCount: 3
unavailableHostCount: 0
codex: available, codex-cli 0.141.0
claude: available, 2.1.202 (Claude Code)
agy: available, 1.1.0
materialHash: ef40ac96cec58c99a62a7de9c15790f78bdb35428cc3ca38e00c1f947078bced
storyFilesHash: 9c4b4d5018a1a14c907850e56c442d783c3a0ed0b9a15ee43a8196960183af83
```

Command:

```bash
node packages/main/dist/cli.js review_escalation_fallback_set \
  --storyId=B-7438 \
  --eligibility=single-host-environment \
  --reason='User-value acceptance: this machine has multiple canonical hosts, so degraded single-host fallback must be refused.' \
  --evidenceRefs='["/tmp/B-7438-user-value-probe.json"]' \
  --actor=main-agent \
  --json \
  --forceTakeover
```

Observed result:

```text
exit code: 1
review_escalation_fallback_set: fresh host availability probe B-7438:RHP-mrdh19fw found 3/3 canonical hosts available; use full 3x2 or explicit-human-approval
```

## Diff Notes

- Expected probe binding before degraded fallback: met.
- Expected canonical host coverage (`codex`, `claude`, `agy`): met.
- Expected refusal when at least two hosts are available: met; the actual
  machine had three available hosts and the fallback command failed closed.
- Expected replacement for agent self-report: met; the refusal cites the fresh
  probe ID and observed host count.
