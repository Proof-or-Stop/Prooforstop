## Trigger Event
The §5/§6 powered ablation campaign (multi-day, 9,240 live `claude -p` cells), on 2026-06-27, forced building out-of-band Host scaffolding — `session-guard.sh` plus key-set resume in `experiments/recovery-runner/powered/run-campaign.mjs`, real-tested surviving a genuine network outage and multiple 429 session-limit cycles — because an audit found autopilot v1 cannot run unattended: `autopilot_resume` always returns `status:'refused'` (`packages/main/src/handlers/lattice-autopilot.ts:1179-1203`), so any crash forces a full restart.

## Key Insight
The autopilot already persists a run record (`.lattice/autopilot-runs/<id>/run.json`) but never consumes it to resume. The fix is identity-keyed idempotent resume: skip steps whose checkpoint is `done`, verified by re-deriving a stable identity key (phase + stepIndex + command + sha256 of inputs), and NEVER a positional count offset — a count offset double-ran the post-void tail in the powered run, producing 21 duplicate records.

## Tradeoff
Resume only at step boundaries; a mid-step interruption re-runs that one step wholesale, which is idempotent because it left no `done` marker. This is simpler and safe versus mid-step checkpointing. M1 deliberately excludes health-pause (M2/C1), runtime throttle (M3/C3), and process parallelism (M4/C5) — order is law (idempotence first), because ramping a non-idempotent parallel runner multiplies duplicate-work bugs.

## Conversation Texture
The operator asked whether the powered-run reliability scaffolding should become a Proofbound capability. A grounded code audit said yes for C1/C2 (positioning-independent) and gated for C3/C5. The operator directed: write the multi-milestone execution plan and open this M1 story as a backlog item, to be started only after the powered run finishes (shared account API budget). Full plan: docs/requirements/decisions/autopilot-v2-reliability-execution-plan.md.
