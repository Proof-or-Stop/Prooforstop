# Plan: B-a745 Add stable validation command identity and an explain-only Story-relevance validation planner

Scope is Rollout Story 1 of `docs/requirements/decisions/story-relevance-dynamic-validation-tiers-execution-plan.md`
(readable at `.worktrees/B-ccf4/docs/requirements/decisions/story-relevance-dynamic-validation-tiers-execution-plan.md`;
the file is not on main). Chosen design is decision option `A-narrow-portable-id`.

## Execution rhythm: RED then GREEN

Every item below is delivered as two commits minimum:

1. **RED commit** — add the fixture cases for that item to
   `packages/main/src/tasks/validation-tier-planner-smoke.ts` and confirm the suite FAILS for the
   expected reason. The commit message starts `RED(CHK-00n):` and records the observed failure text.
2. **GREEN commit** — add the implementation until the suite passes. The commit message starts
   `GREEN(CHK-00n):`.

CHK-006 asserts this rhythm is real by checking that a failing-fixture commit precedes each
implementation commit in `git log`. Squashing RED into GREEN would make that check fail, so do not
squash.

The one exception is CHK-006 itself, which registers the suite; its "RED" is the fail-closed
`unknownPolicy` error from the full-suite runner when the npm script exists but the RESOURCE_POLICY
entry does not.

## CHK-001: Add stable validation command identity and a normalized command-set digest

**Owner**: proof-or-stop-implementer
**DependsOn**: none
**Files**:
- Create: `packages/main/src/core/validation-command-identity.ts`
- Modify: `packages/main/src/core/validation-types.ts` (optional `id?: string` on `ValidationCommand`), `packages/main/src/handlers/verifier.ts` (parse `id` in `configuredValidationCommands`), `packages/main/src/core/validation-evidence-reuse.ts` (EXPORT the existing per-command normalization so the id builder and the pin resolver reuse it instead of duplicating the shell/cwd/env rules; extract only, do not change the behaviour of `buildRoutineValidationIdentity`)
- Test: `packages/main/src/tasks/validation-tier-planner-smoke.ts`

**Design notes**:
- Provisional id = `prov-` + sha256 over the canonical serialization of the NARROW portable tuple
  `{command, args, cwdRelative, shell}` where `cwdRelative` is repo-root-relative and `shell` is the
  same `command.shell === true || platform === 'win32'` rule `buildRoutineValidationIdentity` uses.
  Do NOT invent a second shell rule; import or mirror that one and cover it with a fixture.
- The wide machine-dependent digests (`effectiveEnvironmentDigest`, `executableDigest`,
  `shellExecutableDigest`) are NOT in the id. They are computed via the existing normalizer and
  surfaced as separate pin-resolution evidence (CHK-002).
- `commandSetDigest` = sha256 over the ordered list of
  `{id, label, command, args, cwdRelative, shell, timeoutMs, optional, focus}`.
  `label` and `focus` are BOTH in the digest. This corrects a contradiction in the first draft of this
  plan, which listed a formula omitting them while asserting in prose that focus was included
  (scope-check OQ-1). `label` is required by the spec line "the selection command-set digest and
  existing routine identity both change" for a label rename whose stable id survives; `focus` is a
  config change that must invalidate a plan. Being in the DIGEST is a different question from being in
  RELEVANCE: `focus` is excluded from relevance computation and included in the digest, and those two
  facts are not in tension.
- Duplicate ids (declared or provisional) are a hard error naming both entries. Never dedupe.
- Emit a migration WARNING while any command in the inventory still relies on a provisional id, per
  the spec's migration bullet "show a warning until the project declares stable IDs". The `prov-`
  prefix alone does not satisfy this; the warning must be its own emitted line naming how many
  commands still lack a declared id (queried at emit time, never a figure written into prose).

**Verify**:
- `node packages/main/dist/tasks/validation-tier-planner-smoke.js` ends `validation-tier-planner-smoke: PASS`
- `npx tsc --noEmit -p packages/main` clean

**DoneWhen**:
- A declared id is preserved verbatim; an undeclared one gets a `prov-` id.
- Changing only a command's label, or its array position, leaves its id unchanged.
- Two commands with identical narrow tuples are rejected as duplicates.
- Renaming ONLY a command's label changes the `commandSetDigest` while leaving that command's stable
  id unchanged. Both halves are asserted in one fixture; this is the exact case the spec calls out.
- A warning naming the count of commands still on provisional ids is emitted while any remain, and is
  absent once every command declares an id.
- A fixture proves the routine validation identity digest is byte-identical before and after the
  optional field exists while no id is declared, AND that declaring an id in the project config
  changes `source.inputDigest`. Both assertions are required; the second is what proves the new
  identity only ADDS refusal conditions.

## CHK-002: Add the canonical legacy pin resolver with missing and ambiguous stops

**Owner**: proof-or-stop-implementer
**DependsOn**: CHK-001
**Files**:
- Modify: `packages/main/src/core/validation-command-identity.ts`, `packages/main/src/core/types.ts` (optional `commandId?: string` on `VerificationEvidence`)
- Test: `packages/main/src/tasks/validation-tier-planner-smoke.ts`

**Design notes**:
- Resolution order is exactly the plan's: explicit `commandId` exact match, else normalize the legacy
  free-form `command` string and compare the COMPLETE normalized tuple.
- Legacy string parsing must reuse `commandFromString`'s rule (`SHELL_META_RE` then `splitShellWords`)
  rather than a new parser, so a string with shell metacharacters is compared as
  `{command: <whole string>, args: [], shell: true}`.
- Tuple comparison includes resolved cwd, shell, and the effective environment digest from the
  existing normalizer. Labels and array order are NEVER inputs to the comparison.
- Zero matches -> `pinned_command_missing`. Two or more -> `pinned_command_ambiguous` listing every
  candidate id. Both are STOPS: no plan is produced.
- Never rewrite historical evidence in place to migrate it.

**Verify**:
- `node packages/main/dist/tasks/validation-tier-planner-smoke.js` ends `validation-tier-planner-smoke: PASS`

**DoneWhen**:
- Exact-id, legacy-exact, missing, and ambiguous paths each have a fixture.
- A fixture proves a label difference alone does not break an otherwise ambiguous tie.
- A fixture proves cwd-only and shell-versus-argv differences make two commands distinct.
- `pinResolution` and the normalized-tuple digest are recorded on a successful legacy resolution.

## CHK-003: Add the Story input collector producing a normalized StoryRelevanceInput

**Owner**: proof-or-stop-implementer
**DependsOn**: CHK-001
**Files**:
- Create: `packages/main/src/core/validation-relevance-input.ts`
- Test: `packages/main/src/tasks/validation-tier-planner-smoke.ts`

**Design notes**:
- Changed paths come from `changedFileStatusesBetweenRenameAware` in `core/evidence-freshness.ts`.
  Do not shell out to git here. Deleted paths stay seeds; both sides of a rename stay seeds.
- Material exclusion uses `isStoryMetadataPath` / `isMaterialExcludedPath` from the same module. Do
  not write a local path allowlist.
- Hashes come from `captureEvidenceHashSnapshot`.
- Checklist file declarations and evidence pins follow the semantics already in
  `handlers/delivery-context-pack.ts`; read that first and match it rather than inventing a second
  reading of the same fields.
- Every seed records its provenance (`changed-file` / `checklist-modify` / `checklist-create` /
  `checklist-test` / `evidence-pin` / `risk-signal`).
- A FAILURE to read changed files is `changed_files_unavailable`, never an empty array. This is the
  single most important negative case in this item.
- Collect the remaining two rows of the spec's Story input contract table that the first draft of this
  plan omitted (scope-check gaps 2 and 3):
  - **Command duration history**, read from prior signed validation artifacts. It is an ESTIMATE-ONLY
    input: it may never affect which commands are selected, and CHK-005's "estimated duration and
    basis" output is what consumes it. Absent history is reported as unknown-duration, not as zero.
  - **Verification intent**, carried as human-readable reason context only. The spec is explicit that
    it is "never parsed as the only machine mapping", so it must not be used to derive any
    command-to-seed edge; it exists so the `--explain` output can say why a human cared.

**Verify**:
- `node packages/main/dist/tasks/validation-tier-planner-smoke.js` ends `validation-tier-planner-smoke: PASS`

**DoneWhen**:
- Rename, delete, story-metadata-exclusion, and read-failure fixtures all pass.
- A fixture asserts the collector calls the shared rename-aware reader (for example by injecting a
  failing reader and observing the classified escalation) rather than duplicating git access.
- Duration history is collected and surfaced, with absent history reported as unknown-duration; a
  fixture asserts duration data cannot change the selected set.
- Verification intent is collected as reason context only; a fixture asserts it produces no
  command-to-seed edge on its own.

## CHK-004: Add language-neutral planner types and the fail-closed widening matrix

**Owner**: proof-or-stop-implementer
**DependsOn**: CHK-002, CHK-003
**Files**:
- Create: `packages/main/src/core/validation-tier-planner.ts`
- Test: `packages/main/src/tasks/validation-tier-planner-smoke.ts`

**Design notes**:
- Tier vocabulary is exactly `story-fast` / `story-intermediate` / `repository-full`.
- The reason-code enum comes from the plan's fail-closed matrix. Each code carries a one-sentence
  plain-language gloss in the SAME table that declares the code, so a code can never exist without a
  gloss. The product reviewer flagged bare codes as unusable; the gloss is the fix and is asserted by
  enumerating the enum, not by a hand-copied list.
- In this Story the resolver returns `effectiveTier: 'repository-full'` or a classified stop. There
  is no code path that returns a reduced tier. Prove that with an exhaustive-branch fixture, not a
  comment.
- Empty universe is a classified stop, never a pass.
- Source kinds: `fallback` and `validate-file` report `source_kind_atomic`; `no-validator` preserves
  the existing skip/warn and produces no tier pass.

**Verify**:
- `node packages/main/dist/tasks/validation-tier-planner-smoke.js` ends `validation-tier-planner-smoke: PASS`

**DoneWhen**:
- All four source kinds have fixtures.
- Every reason code has a non-empty gloss, asserted by enumeration.
- A fixture asserts no input produces a reduced effective tier.
- A fixture asserts an empty selection is a stop, not a pass.

## CHK-005: Add the read-only validation_plan CLI with --explain and --json

**Owner**: proof-or-stop-implementer
**DependsOn**: CHK-004
**Files**:
- Create: `packages/main/src/handlers/validation-plan.ts`
- Modify: `packages/main/src/registry.ts`, `packages/main/src/cli/command-catalog.ts`, `packages/main/src/core/command-policy.ts`
- Test: `packages/main/src/tasks/validation-tier-planner-smoke.ts`

**Design notes**:
- Mirror `handlers/review-incremental-context.ts` exactly: a handler factory returning one command
  keyed by its schema name, wired through `registry.registerBatch`, with a zod schema entry in
  `cli/command-catalog.ts`.
- `command-policy.ts` row: `ownershipClass: 'readOnly'`, `destructiveRisk: 'none'`,
  `allowedPhases: 'all'`, with a reason stating it executes no validation command and writes nothing.
- Per the Handler encoding convention: the zod constraints on `storyId` and `tier` are the FIRST
  line of defence only. Re-validate both at the handler entry and at the planner-core entry, and
  write a fixture that calls the core directly with an invalid tier to prove the zod bypass is still
  rejected.
- Do NOT implement the `--focus` / `--tier` mutual rejection. That rule belongs to `validate --tier`
  in Rollout Story 4 and is explicitly out of scope here.
- Human output must include a `finalAuthority: no` line so no reader mistakes this for final proof.

**Verify**:
- `proof-or-stop validation_plan --storyId=B-a745 --tier=fast` prints the documented block
- `proof-or-stop validation_plan --tier=fast` errors with `validation_plan: storyId is required`
- `node packages/main/dist/tasks/validation-tier-planner-smoke.js` ends `validation-tier-planner-smoke: PASS`

**DoneWhen**:
- Human and `--json` outputs both carry requested tier, effective tier, runtime-derived counts,
  per-command reasons, unclassified inputs, glossed escalation reasons, duration estimate with basis,
  and `finalAuthority: no`.
- Missing storyId and unknown tier are rejected by name.
- A fixture snapshots every story file before and after invoking the planner and asserts byte
  equality, and asserts no write/persist/execute/run flag is accepted.

## CHK-006: Add the Story 1 fixture suite and wire it into the canonical test inventory

**Owner**: proof-or-stop-implementer
**DependsOn**: CHK-001, CHK-002, CHK-003, CHK-004, CHK-005
**Files**:
- Create: `packages/main/src/tasks/validation-tier-planner-smoke.ts`
- Modify: `package.json` (`test:validation-tier-planner` script plus the `test:serial-reference` chain), `packages/main/src/tasks/full-suite-runner.ts` (a `repoRead('test:validation-tier-planner')` entry in `RESOURCE_POLICY`)
- Test: `packages/main/src/tasks/validation-tier-planner-smoke.ts`

**Design notes**:
- The suite file is created in the CHK-001 RED commit and grows with each item; this item is where
  its REGISTRATION lands and where the cross-cutting adversarial cases live.
- Membership authority is the root `test:serial-reference` script list. `RESOURCE_POLICY` in
  `full-suite-runner.ts` is a SEPARATE mandatory mapping, checked bidirectionally. Add BOTH.
  Do NOT add anything to `smoke-manifest.json` or `run-all-smokes`; those are explicitly noncanonical.
- Follow the existing `repoRead('test:...')` shape used by the neighbouring entries.

**Verify**:
- `npm run test:validation-tier-planner` exits zero
- `npm run test:full-suite-runner-smoke` passes, proving both registrations landed
- `proof-or-stop validate` green

**DoneWhen**:
- The suite covers every DoneWhen above.
- Both registrations exist and the bidirectional membership check passes.
- A fixture proves each zod-constrained new field is still rejected when the schema is bypassed.
- `git log` shows a RED fixture commit preceding the implementation commit for each of CHK-001
  through CHK-005.
