# Plan: B-f3db Allow TEST transcript evidence as lifecycle artifact

## Goal

Make the TEST-phase transcript evidence path `.koala/story/actives/<storyId>/evidence/transcript-diff.md` a narrow Koala lifecycle artifact so transcript-only evidence updates do not look like product scope drift. Keep the rule closed and path-specific: no broad `.koala/story/**/evidence/**` allowance.

## Constraints

- Keep lifecycle artifact authority in code, not prompt guidance.
- Preserve normal scope controls for source, docs, fixtures, and arbitrary evidence files.
- Do not weaken delivery-check, summary, or reviewer freshness gates.
- Update the truth-source doc that defines lifecycle artifact scope.

## CHK-001

Implementation steps:

1. Inspect the existing lifecycle artifact classifier and scope contract check path.
2. Add one closed allow-list entry for `evidence/transcript-diff.md` relative to a valid active story directory.
3. Ensure the classifier still rejects arbitrary nested evidence files and non-story `.koala` paths.
4. Cover the behavior with a contract test that exercises the exact TEST transcript path plus adversarial nearby paths.

Validation:

- Run `npm run test:process-fact-contract`.
- Run a direct `koala scope_contract_check --storyId=B-f3db` transcript-only scenario if the gate supports the local diff.

## CHK-002

Documentation and gate validation steps:

1. Update `docs/requirements/decisions/lifecycle-artifact-scope.md` to state that `evidence/transcript-diff.md` is a narrow lifecycle transcript artifact.
2. State that this exemption is path-specific and does not authorize broad evidence writes.
3. Re-run `koala story_review`, `koala validate --story=B-f3db --json`, and delivery-related checks after evidence is recorded.
4. Confirm TEST can proceed with transcript evidence without forcing `scope_contract_acknowledge` or reviewer rebind.

Validation:

- The contract test proves transcript evidence classification.
- `koala validate --story=B-f3db --json` covers checklist evidence freshness.
- REVIEW and delivery reviewers consume the same evidence rather than relying on prose.

## Rollback

Remove the path-specific lifecycle artifact entry and revert the lifecycle scope doc paragraph. The default behavior then returns to treating nested evidence writes as normal scope-managed story metadata.
