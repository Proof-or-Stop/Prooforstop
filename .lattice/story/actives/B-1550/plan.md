# B-1550 Plan

## CHK-001

### Objective

Create one English execution-plan decision document at:

```text
docs/requirements/decisions/three-round-two-host-review-escalation-execution-plan.md
```

The document must define the future implementation plan for the 3 round x 2 host review escalation rule. This story is documentation-only; implementation code changes belong to a later story.

### Required Content

The execution plan must cover:

1. The default rule: ordinary stories start with the current Lattice REVIEW flow and do not automatically require 3x2.
2. The automatic escalation rule: if the first REVIEW round records two or more countable problems, the story requires 3 review rounds with 2 independent PASSing hosts per round before DONE.
3. The always-on rule: direct changes to `docs/requirements/decisions/*.md` continue to require 3x2 regardless of finding count.
4. Countable problem semantics: count verified reviewer findings from the first REVIEW round; exclude suspected, disproven, advisory-only, pass-only normalization, B-META audit items, and non-reviewer notes.
5. Host independence semantics: hostId string alone is insufficient. Counted verdicts must expose durable host identity, provider, session id, key id or equivalent signing identity, and material binding.
6. Gate placement: REVIEW can report escalation status; TEST/DONE must enforce fresh final material review before completion.
7. Artifacts and commands: propose the escalation artifact, read-only status command, host-verdict event shape, and evaluator integration.
8. Code touchpoints: list the concrete files likely to change in a future implementation story.
9. Tests and negative controls: include non-trigger, trigger, same-session spoof, same-key spoof, duplicate-host, stale-material, FAIL/BLOCKED, suspected/disproven, and decision-doc always-on cases.
10. Rollout and acceptance criteria: explain how to ship safely without retroactively blocking legacy completed stories.

### Verification

Use a docs_check verificationEvidence entry after the file is written. The evidence must cite the created document and cover all happy, edge, and adversarial verificationIntent refs for CHK-001.

### Non-Goals

This story must not:

- change `packages/main/src/**` implementation files;
- change lifecycle gate behavior;
- add commands or schemas;
- edit story JSON directly;
- use `omx` or `.omx`;
- claim Authority Server receipt completion from local host verdicts.
