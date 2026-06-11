# B-9b8f User-Value Transcript Diff

## Expected

A user checking whether Koala flow facts are hard-coded should see explicit
machine-owned policy output, not reviewer prose. The key expected terminal
signals are:

```text
flow fact policy: pass-only-normalization -> finding_add:pass-only->review_pass_set -> artifact review-passes.json -> gate storyMachine.canPassReview REVIEW to TEST gate
flow fact policy: review-round-iso-string -> artifact findings.json -> gate review signatures and storyMachine.canPassReview REVIEW to TEST gate
flow fact policy: express-verification-policy -> express-exempt -> gate validate verification coverage and story_review PLAN fast-path advisory gate
Verification policy: express-exempt (channel=express; PLAN verificationIntent intentionally skipped)
```

## Actual

`npm run test:process-fact-contract` printed the flow fact policy registry,
including the review-pass/finding/pass-only/reviewRound/express policies and
their artifact/gate mappings:

```text
flow fact policy: express-verification-policy -> express-exempt -> gate validate verification coverage and story_review PLAN fast-path advisory gate
flow fact policy: finding -> artifact findings.json -> gate storyMachine.canPassReview REVIEW to TEST gate
flow fact policy: pass-only-normalization -> finding_add:pass-only->review_pass_set -> artifact review-passes.json -> gate storyMachine.canPassReview REVIEW to TEST gate
flow fact policy: review-pass -> artifact review-passes.json -> gate storyMachine.canPassReview REVIEW to TEST gate
flow fact policy: review-round-iso-string -> artifact findings.json -> gate review signatures and storyMachine.canPassReview REVIEW to TEST gate
Process fact contract verified
```

`npm --prefix packages/main run test:outcome-semantics-smoke` passed and covers
the express transcript plus the non-express negative cases:

```text
outcome semantics smoke passed
```

`koala validate --story=B-9b8f --json` passed with required verification
coverage complete:

```text
Project validation commands passed
Verification intent coverage: 12/13 covered (0 required missing)
```

## Difference

No user-value gap remains. The expected policy names, dispositions, artifacts,
and gate consumers are now visible through the contract command, and express
verification exemption is verified by a dedicated smoke instead of reviewer
wording.
