## Trigger Event
2026-06-20 user review found a parallel-development risk: each shell command may derive a different session id, causing one worktree owner lease to look foreign to the same logical host session. The immediate discussion referenced the existing B-c55d owner-lease fix for Claude Code and the remaining risk for Codex and Antigravity/agy.

## Key Insights
The owner lease core should not learn every host-specific session variable. The stable contract should be canonical LATTICE_SESSION_ID at the Lattice boundary, with host adapters bridging CODEX_SESSION_ID, CLAUDE_CODE_SESSION_ID, Antigravity/agy session sources, or generated dispatch tokens into that one field. ppid must remain a last-resort fallback only.

## Solution Tradeoffs
Adding CODEX_SESSION_ID and future host variables directly to core is quick but repeats the same extension trap. A canonical adapter contract is slightly more work, because wrappers and dispatch metadata must be updated, but it gives future hosts one onboarding rule and keeps owner-lease semantics stable and testable.

## Conversational Texture
The user explicitly challenged the Claude-only fix as leaving a larger design hole. The requested output is an execution document first, with two-host review, because this affects safe parallel Lattice development and should be reviewed before implementation starts.
