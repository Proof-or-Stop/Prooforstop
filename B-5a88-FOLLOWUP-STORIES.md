# Follow-up story specs from B-5a88

Three defects found while converging B-5a88. **None is claimed by any of B-5a88's
13 checklist items**, and none is a regression introduced by this story — B-5a88
renames role IDs, managed-block markers, artifact schemas, and npm identities, and
does not touch validate-gate discriminants, owner-lease resolution, or the
`agent-role-identity` public surface.

Recorded here rather than fixed in place, per the defect-triage rules in
`CLAUDE.md` ("Defect triage: fix, defer, or decline"): each is `medium`/`low`, none
touches security, data integrity, or destructive compatibility, and none can make a
gate report a false PASS. Each entry carries repro steps, evidence, blast radius,
and recommended handling so the deferral is traceable rather than verbal.

`proof-or-stop gap_log` could not archive these to the B-META backlog — it fails
with `invalid_binding_shape` because that backlog's provenance chain is currently
unextendable, a pre-existing framework issue independent of this story. This file
plus the cited finding records are therefore the durable handoff.

**Escalation rule:** if later evidence upgrades any of these to acceptance-blocking
or shows a security/data-integrity impact, pull it into the then-current story
immediately rather than leaving it here.

---

## Story A — Rename validate-gate `provider` discriminants to `proof-or-stop-*`

Tracked on B-5a88 as finding `B-5a88:F-501` (medium, `accepted_risk`, full analysis
recorded on the finding).

**Defect.** The `provider` discriminant emitted into user-visible
`proof-or-stop validate --json` output is still hardcoded to `lattice-*`:

- `packages/main/src/handlers/validate-channel.ts` — `provider: 'lattice-channel'`
- `packages/main/src/handlers/validate-concept.ts` — `provider: 'lattice-concept'`
- `packages/main/src/handlers/validate-lint.ts` — `provider: 'lattice-lint'`
- `packages/main/src/handlers/verifier.ts` — `lattice-verifier`, `-gates`,
  `-reused`, `-reuse-persistence`, `-executed-persistence`,
  `-no-validation-entry`, `-configured-commands`, `-fallback-commands`
- `packages/main/src/handlers/done-required-validation.ts` —
  `provider: 'lattice-done-required-validation'` (3 sites, a DONE-gate path)
- also `packages/main/src/verifier/serve.ts`

**Repro.** `grep -rn "provider: *'lattice-" packages/main/src` → 41 occurrences
across 9 files. Live: `node bin/proof-or-stop.js validate --lint --json` returns
`{"provider":"lattice-verifier-gates",...,"provider":"lattice-lint"}`.

**Why it is RENAMED, not FROZEN.** By `brand-rename-mapping.md`'s own test — "is
this string read back to verify past evidence? NO → RENAMED" — these qualify.
Verified mechanically: these values are only ever **written**. No gate compares
them (`grep -rn "provider ===" packages/main/src/{core,handlers}` matches none of
them), and `handlers/recover-evidence.ts` contains no `provider` reference at all.
Every genuine `provider` read-back site (`core/verdicts.ts`,
`core/host-verdict-bindings.ts`, `core/acceptance-rollout.ts`,
`handlers/cross-host-review.ts`) concerns the unrelated **host-verdict** provider
concept, whose values are `codex` / `local`.

**Blast radius.** 41 occurrences / 9 files, including a DONE-gate path. Positive
exact-string consumers that must change in the same commit:
`packages/main/src/tasks/validate-focused-full-layering-smoke.ts:59` and `:65`
(`provider === 'lattice-verifier-configured-commands'` and its `-focused` variant),
plus `validation-evidence-buffer-smoke.ts`, `verification-freshness-smoke.ts`,
`flow-stability-smoke.ts`. `packages/main/tests/validate-pollution-attribution.test.mjs:292`
references one literal via a negative `assert.notEqual`.

**Recommended handling.** One story that decides RENAMED-additive vs FROZEN per
discriminant, renames the producers, updates the four smoke/test consumers in the
same commit, and adds a dual-read only if any persisted validation trace is ever
read back for verification (current evidence: none is).

---

## Story B — Make the foreign-owner gate fixture immune to ambient session identity

**Defect.** `delivery-context-pack-smoke`'s foreign-owner test can be defeated by
the developer's shell, so a DONE-required suite fails for an environmental reason.

`packages/main/src/tasks/delivery-context-pack-smoke.ts:489-501` simulates a
non-owner with `process.env.LATTICE_SESSION_ID = 'sess-intruder'`, then asserts
`enforceStoryOwnerLeaseGate` throws for `write: true`. But `core/brand-env.ts`
gives the canonical `PROOF_OR_STOP_SESSION_ID` precedence over the legacy
`LATTICE_SESSION_ID`. When `PROOF_OR_STOP_SESSION_ID` is exported — which the
project's own workflow encourages for owner-lease stability — the simulated
intruder still resolves to the lease owner, the gate correctly does **not** throw,
and the assertion fails.

**Repro.**

```bash
PROOF_OR_STOP_SESSION_ID=x node packages/main/dist/tasks/delivery-context-pack-smoke.js; echo $?
# 1 — AssertionError: Missing expected exception: --write is owner-gated on a
#     foreign-owned story   (delivery-context-pack-smoke.js:410)

env -u PROOF_OR_STOP_SESSION_ID -u LATTICE_SESSION_ID \
  node packages/main/dist/tasks/delivery-context-pack-smoke.js; echo $?
# 0 — delivery_context_pack smoke passed
```

**Blast radius.** Produces a **false FAIL**, never a false PASS — it fails closed,
and the ownership gate itself is correct in both directions. But it blocks the
DONE-required root `npm test`, and because one terminal failure cancels the rest,
the summary line reads `18/58 passed` (1 real FAIL + 41 `INTERRUPTED`), which
misreads as catastrophic.

**Recommended handling.** Have the fixture neutralize **both** env spellings
(delete `PROOF_OR_STOP_SESSION_ID` as well as `LATTICE_SESSION_ID`), or drive
identity solely through `resetSessionIdForTest` with an explicit override. Then
sweep for any other fixture that fakes a session identity via the legacy name
only — same latent defeat applies there.

---

## Story C — Remove the unused `isCanonicalAgentRoleId` export

Tracked on B-5a88 as finding `B-5a88:F-500` (low, `accepted_risk`).

**Defect.** `packages/main/src/core/agent-role-identity.ts:104` exports
`isCanonicalAgentRoleId`, which has zero consumers.

**Repro.** Repo-wide `grep -rn "isCanonicalAgentRoleId"` over `packages/`,
`scripts/`, `tests/`, `.githooks/` (excluding `node_modules` and `dist`) returns
exactly one hit: its own definition.

**Blast radius.** One line, no behavior. It is a coherent part of the module's
predicate family (`canonicalAgentRoleId`, `legacyAgentRoleIds`,
`agentRoleIdsEqual`, `canonicalizeAgentRoleText`), and it is the narrowing
type-guard counterpart returning `roleId is CanonicalAgentRoleId` — so its absence
would be the more surprising API shape.

**Recommended handling.** Delete it in any later story that already touches
`agent-role-identity.ts`, or give it its first real consumer. Not worth a dedicated
story on its own.
