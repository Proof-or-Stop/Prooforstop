# B-76a3 Execution Plan

## Scope Principles

This story is a bounded correctness cleanup, not a repository slimming exercise. It only removes or wires items that were already shown to be misleading, unused, or internally inconsistent with the current Lattice CLI product surface.

Core constraints:
- Do not optimize for optimization.
- Do not optimize arbitrarily.
- Only fix real correctness issues.
- Preserve consistency of logic and host-neutral Lattice workflow boundaries.

Out of scope:
- Broad architecture rewrites.
- Deleting packages/lab or supported smoke/regression tooling.
- Reworking Authority, dispatch, planner, browser, or serve behavior unrelated to the five approved cleanup targets.
- Mutating migrated local legacy evidence outside the current B-76a3 story metadata.
- Pushing to GitHub.

## CHK-001 Remove unused MCP dependency from root package metadata

Problem:
The root package metadata declares @modelcontextprotocol/sdk, but current live source paths do not import it. Keeping it makes dependency state claim a supported integration that is not actually used by this product surface.

Plan:
- Remove @modelcontextprotocol/sdk from root package.json only if reference checks confirm it is not imported by live source, bin, or scripts.
- Regenerate package-lock.json with package-lock-only dependency resolution so the lockfile matches package.json.
- Avoid unrelated dependency upgrades or package metadata churn.

Verification:
- Check package.json and package-lock.json contain no @modelcontextprotocol/sdk entry.
- Run rg over package metadata, bin, packages/*/src, and scripts for live references.
- Review git diff for package.json/package-lock.json to ensure the change is limited to the dependency removal or lock normalization.
- Run the project test/build gates.

Rollback:
If a live supported path still requires the dependency, keep it and document the caller instead of deleting it.

## CHK-002 Make implementation review protocol internally consistent

Problem:
packages/main/src/handlers/implementation-review.ts defines implementation_review_result_set/get, and lifecycle/store logic references implementation-review.json, but the commands are not registered or exposed through CLI command metadata. That creates a defined-but-unreachable protocol.

Plan:
- Register createImplementationReviewHandlers in the main registry.
- Add command catalog schemas/help entries for implementation_review_result_set and implementation_review_result_get.
- Preserve existing handler invariants: valid story id required, findings must be structured, fail verdict requires at least one finding, pass verdict rejects high-severity findings.
- Update any legacy fixture that checked the old command location so it verifies the actual command catalog location.

Verification:
- node bin/lattice.js implementation_review_result_set --help succeeds.
- node bin/lattice.js implementation_review_result_get --help succeeds.
- node bin/lattice.js help lists both commands.
- Malformed findings payload is rejected.
- pass verdict plus high severity finding is rejected.
- Build/test gates pass.

Rollback:
If command wiring exposes an unsupported or contradictory protocol, remove the dead handler and associated stale references instead of partially exposing it.

## CHK-003 Resolve obsolete intent coverage module status

Problem:
packages/main/src/core/intent-coverage.ts models legacy fixture/testIntent coverage and has no current runtime consumer. Keeping it in runtime core implies an active product path that current verificationIntent/verificationEvidence flow does not use.

Plan:
- Confirm no live runtime source imports intent-coverage.ts.
- Remove the obsolete runtime core module if it is only held by legacy direct fixture references.
- Remove or adjust direct legacy fixture references that import the deleted runtime module.
- Do not weaken current verificationIntent/verificationEvidence behavior or story_review checks.

Verification:
- packages/main/src/core/intent-coverage.ts no longer exists.
- rg confirms no runtime import/dynamic load of intent-coverage remains.
- story_review for B-76a3 still recognizes all CHK happy/edge/adversarial intents.
- Build/test gates pass.

Rollback:
If an active runtime caller is found, keep the module and either rename/relocate it honestly as supported compatibility or open a narrower follow-up.

## CHK-004 Archive or remove one-time migration scripts that are no longer product commands

Problem:
Several scripts are one-time migration utilities rather than supported product commands. Leaving them in active scripts makes the product tree look broader than the maintained CLI surface.

Plan:
- Delete only the approved one-time scripts after confirming no npm script, runtime source, test, or active doc still invokes them:
  - scripts/convert-fixtures.cjs
  - scripts/migrate-annotations.cjs
  - scripts/migrate-fixture-reform.mjs
  - scripts/migrate-fixture-reform-v2.mjs
  - scripts/remove-file-level-test.cjs
- Update docs that mention removed script paths so they no longer instruct users or agents to run missing tools.
- Do not delete supported smoke, verification, build, or release scripts.

Verification:
- git ls-files for the approved scripts returns empty.
- rg over package metadata, runtime source, tests, and docs finds no active invocation of removed scripts.
- git diff --name-status shows script deletions are limited to approved one-time utilities.
- Build/test gates pass.

Rollback:
If a named script is still a documented active maintenance path, keep it and reclassify it explicitly instead of deleting it.

## CHK-005 Remove package-local legacy active story metadata from product tree

Problem:
packages/main/docs/story/actives contains old package-local active story metadata while current story lifecycle state is under .lattice/story/actives. The duplicate active-story location can confuse product-tree audits and agents.

Plan:
- Remove tracked package-local legacy active story files under packages/main/docs/story/actives.
- Remove package-local obsolete metadata only when it is proven to point at old package paths and not current canonical .lattice story state.
- Preserve current B-76a3 story metadata under .lattice/story/actives and do not mutate migrated local historical evidence outside this story.
- Update any active references that still describe packages/main/docs/story/actives as the live story source.

Verification:
- git ls-files packages/main/docs/story/actives returns empty.
- node bin/lattice.js checklist_get for B-76a3 succeeds, proving canonical .lattice story state remains readable.
- rg confirms no live runtime/test/doc reference treats packages/main/docs/story/actives as active story storage.
- Build/test gates pass.

Rollback:
If a test intentionally depends on package-local metadata, move that fixture into an explicit test fixture path instead of leaving active story residue in product docs.

## Integrated Validation Checklist

Before marking checklist items done:
- Run targeted rg/reference checks for each deletion.
- Run npm/package build checks after source edits.
- Run implementation-review command help and negative validation checks after wiring.
- Run npm test as the final behavior lock.
- Record verificationEvidence on each checklist item with exact commands and outcomes.

Before DONE:
- Commit all scoped changes.
- Pass REVIEW using signed review runs and review passes or findings.
- Pass TEST via lattice validate.
- Provide summary and delivery check evidence required by the DONE gate.
