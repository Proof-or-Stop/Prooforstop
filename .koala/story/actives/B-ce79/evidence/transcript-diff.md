# B-ce79 Real-Machine Transcript Diff

## Expected

Formal Layer 2 Engineering proof should unlock only the Engineering Baseline
claim when real formal suite evidence exists. Forged suite summaries, forged or
duplicated review-host artifacts, stale evidence, missing lifecycle evidence,
and missing receipt evidence digest bindings should fail closed. CLI local
evaluation must not claim Authority receipt verification, production DONE, or
full unattended authority.

## Actual Transcript

Commands executed in the story worktree:

```text
npm --prefix packages/main run build
PASS: TypeScript build completed.

npm --prefix packages/main run test:lattice-baseline-smoke
PASS: lattice baseline smoke passed.

npm run test:process-fact-contract
PASS: Process fact contract verified.

npm --prefix packages/main run test:command-ownership-contract
PASS: command-ownership contract passed.

npm --prefix packages/main run test:reviewer-readonly-command-policy-smoke
PASS: reviewer-readonly command policy smoke passed.

npm --prefix packages/main run test:lifecycle-registry-contract
PASS: lifecycle-registry consistency.

KOALA_SESSION_ID=sess-01a1a872051b5752 lattice validate --story=B-ce79 --json
PASS: allPass=true, npm test passed, verification coverage 24/24 covered.
```

Two-host review result:

```text
Claude CLI concept reviewer: VERDICT PASS.
Claude CLI test-coverage reviewer: VERDICT PASS.
Codex CLI quality reviewer: VERDICT PASS.
```

## Diff

No user-visible or gate-visible difference from expected behavior was observed.
Layer 2 Engineering can be unlocked by formal proof only; higher layers remain
locked. Local CLI proof remains non-authority and does not claim production or
full unattended authority.

