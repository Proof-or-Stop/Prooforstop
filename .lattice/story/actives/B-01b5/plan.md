# B-01b5 Plan

## CHK-001
Implement Codex adapter doctor diagnostics as a hard CLI path. Reuse a shared Codex adapter check module so doctor reports manifest drift, agents mirror, local wrapper health, global fallback heartbeat, unsupported runtime assets, source/session behavior, and aux availability. User-visible output must include PASS/warn/fail rows and actionable repair commands.

## CHK-002
Record structured Codex process events and role telemetry from the Codex wrapper/global fallback path. Capture source, session, role, storyId, phase, command, entrypoint, result, and concise error summary. Reviewer attribution should be protected by hard checks so pass/finding records cannot silently become main-agent records.

## CHK-003
Add scriptable Codex verification via a shared implementation exposed as koala verify_codex and koala init --verify-codex. It must validate manifest exactness, agents mirror, local wrapper heartbeat, global fallback heartbeat with KOALA_ACTIVITY_RECORD_READONLY=1, and absence of .Codex/hooks/.Codex/settings.json.

## CHK-004
Update README, AGENTS, and .Codex/README only after the hard capabilities exist. The docs should describe real commands and hard guarantees: doctor diagnostics, telemetry, verify_codex/init --verify-codex, and no fake Codex runtime hooks/settings.

## CHK-005
Make REVIEW/DONE gates consume Codex hard evidence. The gate should be able to distinguish missing evidence, failing evidence, and passing evidence for Codex doctor/verify/telemetry. This closes the scope-review gap: Codex hard capabilities are not only runnable; they become machine-consumable inputs to completion.
