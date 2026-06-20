## CHK-001
Add the read-only command surface and report model. Create a core StoryReadinessReport assembler that reads story phase, git head/material hash, checklist evidence, validation references, review artifacts, delivery state, summary state, and DONE oracle rows. Add a lifecycle_check handler that renders text or JSON and rejects runCommands/writeEvidence in V1.

## CHK-002
Map existing facts into readiness rows. localReady is computed strictly from readiness.some(row.blocking). Preserve source/category/code/owner/next action per row. Treat warnings/advisories as visible but non-blocking, and keep Authority/fullAuthority/production claims false unless later verified receipt readers supply facts.

## CHK-003
Add focused smoke coverage for the user-visible command. The smoke should prove JSON shape, text rendering, blocking semantics, exact next command hints, failure on runCommands/writeEvidence, and no metadata mutation by comparing story files before and after lifecycle_check. Wire it into configured validation if it is narrow enough for routine runs.
