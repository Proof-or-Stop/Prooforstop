# testIntent Adversarial Review System

## Decision 1: a checklist item must carry testIntent

Each checklist item may carry a `testIntent` field, with a three-column structure:
- **happy**: the normal path
- **edge**: the boundary path
- **adversarial**: the adversarial path (brute-force operations, network loss, concurrency, timing anomalies)

When testIntent is missing, story_create gives a prompt. If the three columns cannot be filled, it means the item was not broken down correctly.

**Rationale**: Test intent determines test quality. The script is merely the means of execution; if the intent design is inadequate, no amount of test scripts will help.

## Decision 2: Agent A/B adversarial review

- Agent A is responsible for breaking down requirements and implementing code
- Agent B is responsible for reviewing the completeness of testIntent (finding weak spots, missed cross-scenarios, and constraints from the truth that are not covered)
- The one who writes testIntent and the one who reviews testIntent must be separate

The `story_review` command outputs `_reviewPrompt`, which contains truth + checklist + testIntent comparison material, to be handed to an independent agent for review.

**Rationale**: You cannot find your own blind spots when reviewing yourself. testIntent is the exam paper (reviewed by Agent B), and the fixture/browser case is the answer (written by Agent A according to the intent).

### testintent_handoff handoff package

In the PLAN phase you can run `lattice testintent_handoff --storyId=B-xxx` to have the CLI generate a structured handoff package for the test-intent agent. The handoff package contains the story summary, the target worktree, the checklist items still to be filled in, the count of existing verificationIntent/testIntent, and an example `checklist_update` command.

`testintent_handoff` is a formal CLI command, and should satisfy all three layers of consistency: discoverable via `lattice help` / `lattice testintent_handoff --help`, callable through the handler registry, and allowed to execute on the PLAN phase allowlist. It is not an adapter for a specific story, nor a hidden replacement for `dispatch`; its sole responsibility is to clearly package the context the test-intent agent needs during the PLAN phase.

## Decision 3: division of labor between white-box fixtures and browser tests

- **White-box fixture**: function correctness (fn + execute + expect)
- **Browser test**: business correctness (simulate a real user's operation path, covering boundaries and exceptions)

A browser test verifies "how the business chain behaves under real operations," not just "the rendering mapping." For example: after a level-up, does the experience bar reset to zero or overflow; will brute-force rapid clicking cause a double charge.

In the DEV phase, code and fixtures (including browser cases) are written together, with testIntent established first.

## Decision 4: a three-layer defense against missed requirements

- **Before the fact**: the three-column structure forces completeness + Agent B's adversarial review
- **During the fact**: the checklist is validated item by item, and marking an item done requires the test corresponding to its testIntent to pass
- **After the fact**: a code-coverage scan catches omissions (which code paths are not covered by testIntent)

There is no silver bullet for requirement completeness; multiple layers of defense lower the probability of an omission.

## Decision 4.1: verificationEvidence may express a verdict, but does not change gate semantics

The current lifecycle uses `verificationIntent` / `verificationEvidence` to replace the old `testIntent` fixture-only flow. Evidence still determines the gate result by `kind`, `result=pass|fail`, waiver, and freshness; the schema enum is still `verdict=success|blocked_classified|audit_only|waived`, but the user-visible coverage is rendered as a hyphenated label, such as `verdict=blocked-classified` / `verdict=audit-only`. For example, when a spike proves and classifies a blocker, it can show `verdict=blocked-classified`, but as long as `result=fail`, the coverage is still failed and cannot be counted as success.

## Decision 5: standards for breaking down a checklist item

A qualified item must satisfy all of the following at once:
1. It has an observable result (the user can see/feel the change)
2. It has a clear input trigger (an operation, an event, or time all count as triggers)
3. The happy/edge/adversarial columns can all be filled
