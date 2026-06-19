## Trigger Event
On 2026-06-19, staging full Authority DONE live E2E failed before queued job creation because DONE preflight returned materialOverlapAudit.present=false for the signed gate input. The handoff is documented in docs/requirements/decisions/authority-done-material-overlap-audit-cli-fix.md.

## Key Insights
The server contract is already clear: materialOverlapAudit belongs inside decision on POST /v1/gates/evaluate and must be present before the envelope is signed. /v1/checks and /v1/commands are not the submission path for this gate fact.

## Solution Tradeoffs
The fix should be narrow: add the typed field to CLI gate contracts, pass it through the signed envelope, update the live smoke, and add regression coverage. Do not add new server endpoints, new product concepts, or broad parallel-flow redesign.

## Conversational Texture
The user wants this solved through the Lattice CLI story/worktree process, with the existing principles intact: no arbitrary optimization, only real correctness fixes, and host-neutral logic where Codex CLI and Claude CLI remain evidence producers while Authority Server mints the final gate receipt.
