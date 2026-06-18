# B-f14a Execution Plan

This story mirrors the upstream Authority gate-actor contract in the CLI. Keep the change narrow, fail-closed, and aligned across code, docs, and smoke coverage.

## CHK-001 Mirror upstream gate-actor policy in authority-client and command-policy

Goal: align the CLI role helper and command policy with the upstream Authority contract, remove stale mac_ui wording, and keep fail-closed behavior.

Steps:
1. Update `packages/main/src/core/authority-client.ts` so the gate actor wording matches the upstream contract and still rejects missing or stale gate-capable input.
2. Update `packages/main/src/core/command-policy.ts` so the CLI command policy no longer advertises `main/mac_ui/human` wording.
3. Keep the change local to the downstream mirror; do not invent a new environment model or a shared cross-repo registry for this fix.

Validation:
- Run focused tests or smoke checks that exercise the gate actor path.
- Confirm valid inputs still pass through.
- Confirm stale `mac_ui` wording is gone from the CLI runtime path.

Risks:
- A helper or policy entry is missed and the stale wording survives in one path.
- The cleanup accidentally widens the allowed role set.

## CHK-002 Sync CLI docs and contract decisions

Goal: update the CLI-facing decision docs so they match the upstream contract and keep the thin-client boundary clear.

Steps:
1. Edit `docs/requirements/decisions/lattice-authority-live-integration.md` to remove the stale `main/mac_ui/human` gate wording.
2. Edit `docs/requirements/decisions/authority-client-role.md` so the role boundary stays consistent with the downstream mirror and the upstream Authority contract.
3. Avoid introducing new environment tiers or new product modes while rewriting the docs.

Validation:
- Search the CLI docs for `mac_ui` and verify only legacy/history traces remain, if any.
- Confirm the docs and code use the same neutral gate vocabulary.

Risks:
- A doc keeps the stale role name alive.
- A doc update drifts into a policy change instead of a mirror of the upstream contract.

## CHK-003 Add smoke coverage for the cleaned wording

Goal: prove the CLI still fails closed and the old mac_ui wording is gone.

Steps:
1. Update `packages/main/src/tasks/authority-client-smoke.ts` to assert the cleaned failure reason and the real allowed path.
2. Update `packages/main/src/tasks/authority-completion-smoke.ts` so the completion smoke does not depend on the stale role wording.
3. Keep the smoke assertions focused on regressions in wording and fail-closed behavior.

Validation:
- Run the smoke scripts after the code/doc changes.
- Confirm valid inputs still succeed and stale inputs still fail.
- Confirm the old mac_ui phrase no longer appears in the runtime output.

Risks:
- Smoke checks only cover one path and miss another stale reference.
- The assertions become brittle by pinning the wrong text.
