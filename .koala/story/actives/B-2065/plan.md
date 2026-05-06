# B-2065 Plan: Koala Validation And Gate Reliability Hardening

## CHK-001 Harden validate command execution and JSON receipts

**Intent**: Preserve the existing generic validate command protocol and close any receipt gaps that could hide false-green validation.

**Approach**: Inspect configured command discovery, shell command detection, and validation executor receipts. Keep shell behavior only for string commands that require shell semantics or explicit shell configuration. Do not hard-code PVSC or any pytest count.

**Verify**: Run validation protocol smoke and direct CLI checks that assert shell=true for cd/&& commands, shell absent for structured argv commands, durationMs/code/output are present, required failures fail, and optional failures warn.

**DoneWhen**: A user can trust koala validate --json to show the exact command that ran and whether it actually passed.

## CHK-002 Make CLI JSON argument schema errors fail fast with exact messages

**Intent**: Make invalid CLI JSON arguments visible enough that agents do not mistake a failed mutation for success.

**Approach**: Keep CLI schema validation at the engine boundary and add or preserve regression checks for nested verificationIntent enum errors and malformed JSON. Avoid fallback paths that print only generic help or status guidance.

**Verify**: Run a bad checklist_update with verificationIntent.happy[0].type=integration_test and assert nonzero exit plus verificationIntent.happy.0.type and expected enum values in stderr. Confirm the checklist is not mutated.

**DoneWhen**: The user sees the invalid field path and legal values immediately.

## CHK-003 Align status next-step and DONE messaging with preflight blockers

**Intent**: Make koala status/session_brief/next render the same blocker facts that story_advance DONE enforces.

**Approach**: Reuse the existing DONE pre-check row contract where possible. If wording changes are needed, keep them renderer-only and backed by the shared row ids: git-working-tree, delivery-check, story-summary, validation evidence, and related docs.

**Verify**: Run flow-stability smoke against synthetic TEST stories and assert session_brief and next list blockers, suggest summary_set/delivery_check_set where needed, and do not emit the old optimistic DONE shortcut.

**DoneWhen**: In TEST, users know exactly which blocker to fix before DONE.

## CHK-004 Whitelist Koala-generated lifecycle artifacts during DONE stray checks

**Intent**: Keep DONE merge safe when Koala generated story metadata exists in the main working tree, without deleting human drafts.

**Approach**: Maintain exact basename whitelist entries for generated lifecycle artifacts only. init-self-check.json is allowed; arbitrary notes or unknown files remain blockers with stash/rm instructions.

**Verify**: Run stray cleanup smoke that creates init-self-check.json and an unknown draft file. The generated artifact is cleaned and reported; the unknown file blocks and remains.

**DoneWhen**: Koala self-generated metadata no longer blocks DONE, but human untracked files are still protected.

## CHK-005 Add regression tests and doctor/advisory coverage

**Intent**: Give users a visible project-level diagnostic that explains validation fallback risk without turning project-specific test strategy into a hard gate.

**Approach**: Add a doctor Validation scan section or strengthen existing doctor output. Report whether validate.ts exists, whether configured validation commands exist, whether shell-style configured commands are intentionally shell receipts, and whether fallback discovery is advisory. Keep pytest collect counts and benchmark assumptions out of core runtime gates.

**Verify**: Add/extend smoke coverage for doctor JSON/text output and docs. Confirm the output is generic, mentions configured/fallback status, and contains no PVSC/story-id/exact pass-count requirement.

**DoneWhen**: A user running koala doctor can understand whether validation is explicit, discovered, or missing, and what to configure next.
