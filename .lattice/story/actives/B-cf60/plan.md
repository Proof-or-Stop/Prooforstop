# Plan: B-cf60 Allow stories to declare expected generated product artifacts

## CHK-001: Add per-story artifact declaration surface

**Owner**: koala-implementer
**DependsOn**: none
**Files**:
- Create: packages/main/src/handlers/artifact-declare.ts (new handler exporting `artifact_declare({storyId, path, reason, relatedIntent})`)
- Modify: packages/main/src/core/store.ts (add `writeDeclaredArtifacts(storyId, data)` + `readDeclaredArtifacts(storyId)`)
- Modify: packages/main/src/cli-engine.ts (register artifact_declare command)
- Modify: packages/main/src/registry.ts (register handler)
- Modify: packages/main/src/core/command-policy.ts (classify as gateEvidence + metadata-write so B-3506 auto-commits)
- Modify: packages/main/src/core/config.ts (add to DEFAULT_PHASE_TOOLS \*)

**Verify**:
- `koala artifact_declare --storyId=B-cf60 --path=tests/output/foo.json --reason="..." --relatedIntent=CHK-001:happy:0` writes `.koala/story/actives/B-cf60/declared-artifacts.json` and prints success
- Auto-commit (B-3506) immediately commits the new file
- Path validation throws on glob/wildcard/.. inputs

**DoneWhen**:
- Handler at `packages/main/src/handlers/artifact-declare.ts` with Zod schema + runtime double-validation
- Schema: `path` exact relative path (no `*`, no `..`, no leading `/`); `reason` ≥10 chars; `relatedIntent` matches `CHK-\d+:(happy|edge|adversarial):\d+` OR a delivery promiseId
- Same path re-declared overwrites entry (idempotent); output contains "overwritten"
- B-3506 helper auto-commits declared-artifacts.json after handler write

## CHK-002: Wire declarations into the classifier

**Owner**: koala-implementer
**DependsOn**: CHK-001
**Files**:
- Modify: packages/main/src/core/dirty-worktree.ts (`dirtyWorktreeClassifierOptionsFromConfig` accepts optional `storyId` or `declaredArtifactPaths` extension; or a new fn `classifierOptionsWithStory(config, storyId)`)
- Modify: callers of `classifyDirtyWorktree` (story-advance.ts, validation-executor.ts, session.ts) — pass storyId when available so declarations are read

**Verify**:
- Smoke: after `artifact_declare ... path=tests/output/foo.json`, calling `classifyDirtyWorktree` with that path dirty returns category=`declared_artifact_changes`
- Without declaration, same path → `unexpected_dirty_files`
- `koala session_brief` output groups the declared path under `declared_artifact_changes` heading

**DoneWhen**:
- Classifier reads per-story declared-artifacts.json when given a storyId
- Sibling undeclared paths under same prefix remain `unexpected_dirty_files`
- Materially modified files outside declarations continue to land in `unexpected_dirty_files` (or `material_source_changes` if under sourceRoot)

## CHK-003: DONE gate reference check

**Owner**: koala-implementer
**DependsOn**: CHK-001, CHK-002
**Files**:
- Modify: packages/main/src/handlers/story-advance.ts (extend `buildDoneChecklist` with a `declared-artifacts-referenced` row)
- Optionally create: packages/main/src/core/declared-artifact-gate.ts (pure fn for the reference check)

**Verify**:
- DONE pre-check shows row `[✓] declared artifacts referenced: N/N` when every declared artifact has matching intentRef in verificationEvidence OR matching promiseId in delivery-check
- DONE pre-check shows row `[✗] declared artifacts referenced: M/N (unreferenced: ...)` with `blocking: true` when at least one unreferenced
- Empty declared-artifacts.json (no entries) → row reads `[✓] declared artifacts referenced: 0/0 (no declarations)` and is non-blocking

**DoneWhen**:
- Reference matcher validates intentRef matches an EXISTING `checklist.items[*].verificationIntent[lane][index]` entry (preMortem #2 anchor — no bogus intentRefs)
- Blocker type `unreferenced_declared_artifact` flows into the DONE gate error list
- When story has no declarations, gate row is informational only, never blocking

## CHK-004: Regression coverage for BL21 lacZ + adversarial paths

**Owner**: koala-implementer
**DependsOn**: CHK-001, CHK-002, CHK-003
**Files**:
- Modify: packages/main/src/tasks/flow-stability-smoke.ts (extend with `assertDeclaredArtifactsChannel` block)
- Modify: packages/main/src/tasks/validation-protocol-smoke.ts (regression for the BL21 lacZ viewer path)

**Verify**:
- `npm --prefix packages/main run test:flow-stability-smoke` covers happy + edge + adversarial intents
- `npm --prefix packages/main run test:validation-protocol` covers the BL21 lacZ viewer regression specifically
- Both print `✓ passed`

**DoneWhen**:
- Smoke uses the literal BL21 lacZ path `tests/output/bl21_lacz_ecoli_minicell/prodenovo_viewer.json`
- Test cases: (a) undeclared → unexpected, (b) declared+referenced → declared_artifact_changes + DONE pass, (c) declared+unreferenced → DONE blocked, (d) malicious path (`*`/`..`) → handler throws

## Validation

After evidence is recorded:
- `npm --prefix packages/main run build`
- `npm --prefix packages/main run test:flow-stability-smoke`
- `npm --prefix packages/main run test:validation-protocol`
- `koala validate --story=B-cf60 --json`

## Rollback

If declared_artifact_changes routing has unforeseen effects, the classifier change is additive (empty declaration → identical to B-6326 behavior); set `declaredArtifactPaths: []` in callers to disable while keeping the artifact_declare handler available for forward compatibility. DONE gate row can be soft-disabled by guarding the reference check behind `declarations.length > 0`.
