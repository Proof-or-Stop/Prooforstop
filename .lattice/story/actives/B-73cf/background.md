## Trigger Event
B-4bd7 on 2026-06-23 registered lattice-workflow-efficiency-baseline-v1 after B-e9cb observed that full validation could run near the previous timeout envelope and create false failure pressure.

## Key Insights
The problem is not that full validation exists. The correctness issue is that development and review lacked a first-class focused path, while the default command timeout left too little margin for normal full validation behavior.

## Solution Tradeoffs
Prefer a narrow CLI/config contract for focused versus full validation and a safer timeout default. Do not remove full validation, skip DONE-required commands, or weaken verification evidence freshness.

## Conversational Texture
The user wants the six efficiency items fixed as real correctness improvements, each tied back to the baseline, without arbitrary optimization or hidden weakening of Lattice gates.
