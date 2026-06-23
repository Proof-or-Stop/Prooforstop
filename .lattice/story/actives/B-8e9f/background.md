## Trigger Event
On 2026-06-24, the first real powered --run of the live-loop harness from B-b739 (merge 663ad6d) produced 9/9 records but every scenario reported turns=1, and three scenarios never exercised their fault.

## Key Insight
parseClaudeResult marks any successful claude -p call shipped=true, so runLiveLoop always breaks after turn 1. B4 and B5 inject on turn 2 which is never reached; B10 classifies purely on the always-true shipped flag so it is always AMPLIFIED. The six turn-1-fault scenarios discriminate on disk artifacts and stay valid.

## Tradeoff
Materializing the B4/B5 fault at turn 1 reframes mid-task injection as a start-state fault recovered from disk. For a single-shot agent this is the only way to exercise the fault; SAFE_STOP becomes unreachable for B4/B5 which is acceptable since RECOVERED-vs-AMPLIFIED is the key distinction and self-check stubs cover all three outcomes. B10 moves to a disk-grounded done-vs-stop signal.

## Conversation Texture
After the first powered run the operator was shown 3 of 9 scenarios did not fire their multi-turn fault and chose fix-harness-then-rerun-all over caveat-backfill, waiving cost, so the harness must be corrected before an honest powered re-run feeds the paper recovery table.
