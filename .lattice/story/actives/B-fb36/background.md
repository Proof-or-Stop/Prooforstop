## Trigger Event
On 2026-06-19, the DONE Prepare Automation Execution Plan was accepted after B-7e47 exposed repeated manual closure work around merge-main, stale evidence, validate, done_closure, and version guidance. The implementation now needs a story so the documented workflow becomes a real Lattice CLI capability.

## Key Insights
The time cost is not from skipping hard review or test gates; it comes from manually sequencing existing checks that already fail closed. The command must keep local DONE, degraded-single-host assurance, Authority DONE, and production DONE separate while making the next actionable blocker explicit.

## Solution Tradeoffs
The conservative approach is to implement pre-DONE readiness only and move version mutation to a later post-DONE finalization path. This avoids changing material hashes after done_closure passes and prevents a false ready state caused by dirty version files or stale evidence.

## Conversational Texture
The user wants speed without lowering the bar. The implementation should reduce mechanical waiting and repeated operator judgment, but it should still surface blockers honestly and stop rather than inventing shortcuts when evidence must be rerun or committed.
