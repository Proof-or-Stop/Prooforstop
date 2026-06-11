# Plan: Story Capsule Projection

## Guardrails

- Resolve capsule paths through configured storyDir via StoryStore/loadConfig. Do not hardcode docs/story, Docs/story, or .koala/story.
- Treat process-events.jsonl and evidence artifacts as authority. Capsule files are projection and handoff state only.
- Missing evidenceRefs/processEventRefs should be visible in read commands and blocking in validation/gate-facing diagnostics.
- OMX import means reading optional local .omx context/log/metrics summaries as non-authoritative background; deleting .omx must not change Koala behavior.

## CHK-001

Define a core capsule contract in TypeScript, likely in packages/main/src/core/story-capsule.ts plus type exports in core/types.ts. Add StoryStore helpers for capsule paths and JSON read/write so capsule.json, session-brief.md, and handoff.md live under <configured storyDir>/<storyId>/capsule/. The no-capsule case should return a null/empty projection and session_brief must keep its current output.

Validation: smoke fixture with storyDir=.koala/story/actives proves files land under the configured path and no-capsule reads degrade gracefully.

## CHK-002

Add run record support under capsule/runs/<runId>/ with run.json, transcript.md, metrics.json, and artifacts.json. Keep transcript.md concise by default: commands, result, selected output/error excerpt, and artifact references instead of full chat logs. Run metadata should include storyId, checklistId, provider, role, startedAt, endedAt, result, commands, evidenceRefs, processEventRefs, and source.

Validation: capsule_run_add smoke writes a run, rejects invalid story/checklist refs, and records enough metrics to display last run in session_brief.

## CHK-003

Wire capsule mutations to process-events by appending capsule_updated, handoff_written, run_added or run_metrics_recorded events. Implement a rebuild path that recreates baseline capsule.json from process-events plus current story/checklist/evidence summaries. process-events stays append-only; capsule is replaceable projection.

Validation: delete capsule/capsule.json in a temp fixture, run rebuild/update, and assert a basic capsule reappears with processEventRefs while process-events remains intact.

## CHK-004

Add CLI commands and handlers: capsule_show, capsule_update, capsule_handoff, capsule_run_add, and likely capsule_import_omx from CHK-006. Register them in MAIN_TOOLS, registry, command-policy, process-fact-levels, and process-fact-registry. Integrate a compact Current Story Capsule block into session_brief for the active story only.

Validation: command ownership/process-fact contract tests must pass; session_brief smoke asserts capsule block appears when present and stays absent/quiet when missing.

## CHK-005

Implement reference validation for evidenceRefs and processEventRefs. Evidence refs should point to existing story evidence files or checklist verificationEvidence entries. processEvent refs should resolve by event id/line/digest or a stable line reference. Forged session-brief.md cannot be consumed as gate evidence; missing refs should fail capsule validation or emit a clear warning in read-only display.

Validation: add fake session-brief.md claiming completion, omit real evidence refs, and assert DONE/checklist validation remains blocked or capsule validation reports missing refs.

## CHK-006

Implement capsule_import_omx as explicit non-authoritative import. It may read .omx/context, .omx/metrics.json, and .omx/log summaries when present, write capsule/imports/omx-<date>.md, and tag imported refs with source=omx_import and authority=non_authoritative. Keep .omx optional and outside Koala authority. Add docs/tests for all new commands and the fake-evidence resistance path.

Validation: smoke tests pass when .omx is absent; when present, import creates non-authoritative background only and no gate starts trusting it. Run npm run build, targeted capsule smoke, test:process-fact-contract, command ownership contract or equivalent lifecycle registry checks, and session_brief smoke.
