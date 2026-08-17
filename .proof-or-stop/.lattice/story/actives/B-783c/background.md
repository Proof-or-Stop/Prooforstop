## Trigger Event
On 2026-07-09, lattice codex verify failed in /Users/jek/Documents/Work/deepswe-pos-codex-gpt55-run/solver-visible with Global fallback heartbeat reporting no activity heartbeat for a codex-check-global session.

## Key Insights
The global-thin target has .lattice/lattice.json but no lattice.config.json. writeLog currently uses canonical config detection, so session_brief can execute while .lattice/activity.jsonl remains unwritten.

## Solution Tradeoffs
The fix should not add .lattice/lattice.json to loadConfig project config filenames because its schema is managed adapter metadata, not canonical project config. A narrower activity-root helper keeps parsing behavior stable.

## Conversational Texture
The handoff corrected an earlier repository mixup and emphasized using proofbound only. The user wants a concrete CLI fix, focused regression coverage, build verification, and a solver-visible codex verify smoke.
