# B-4a8e Execution Plan

## CHK-001 Show configured gitRoot status in non-git session brief

Goal: make `session_brief` truthful for wrapper-root projects where the metadata root is not git-backed but `gitRoot` is explicitly configured and resolves to a child git repository.

Implementation path:
- In `packages/main/src/handlers/session.ts`, add a small read-only helper that checks configured signed workspace status for the current metadata root.
- Reuse existing config / signed workspace resolution semantics where practical; do not scan for child repos and do not mutate config.
- Render the new status only for non-git metadata roots with a configured gitRoot result.

Expected visible transcript:
- `Signed workspace: OK`
- `configured gitRoot: clawcreek`
- `resolutionSource: configured-git-root`

Validation:
- Add field regression smoke coverage for configured wrapper-root fixture.
- Confirm normal git-backed project output does not gain this wrapper-root block.

## CHK-002 Keep fail-closed behavior for unresolved wrapper roots

Goal: preserve current fail-closed behavior for metadata roots that are not git-backed and do not have a valid configured gitRoot.

Implementation path:
- Keep the existing `Non-git project` warning for unresolved wrapper-root layouts.
- If configured gitRoot exists but cannot verify, render it as unresolved/invalid and never claim OK.
- Do not call `config repair`, do not choose a child repo, and do not write `lattice.config.json`.

Expected visible transcript:
- unresolved cases include `Non-git project` or `signed workspace unresolved`
- unresolved cases do not include `Signed workspace: OK`

Validation:
- Add field regression smoke coverage for unconfigured wrapper-root fixture and invalid configured gitRoot fixture.
- Assert config file contents are unchanged after `session_brief`.

## CHK-003 Operator sees configured and unresolved wrapper-root states clearly

Goal: make the product-visible CLI output stable enough that future Hosts can tell whether the issue is solved without parsing internal resolver logs.

Implementation path:
- Extend `packages/main/src/tasks/field-regression-cli-smoke.ts` near existing wrapper-root resolver coverage.
- Assert exact user-visible phrases rather than only JSON resolver fields.
- Keep tests scoped to CLI output and non-mutation behavior.

Expected visible transcript:
- configured fixture asserts `Signed workspace: OK`
- unresolved fixture asserts absence of `Signed workspace: OK`

Validation:
- `npm --prefix packages/main run build`
- `node packages/main/dist/tasks/field-regression-cli-smoke.js`
- `node scripts/verify-process-fact-contract.mjs` if command/registry facts are touched; otherwise not required.
