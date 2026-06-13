## Trigger Event
On 2026-06-13, the user reviewed packages/main/src/cli-engine.ts and found many Chinese descriptions remaining in the CLI engine. A local audit found 762 lines with Chinese characters in cli-engine.ts, mostly schema descriptions, command descriptions, help text, comments, and next-step hints.

## Key Insights
The request is not to immediately rewrite the CLI implementation. The user needs a reviewable execution document first, including each proposed Chinese-to-English translation, so the open-source language policy can be reviewed before code and docs are changed.

## Solution Tradeoffs
Create a narrow documentation-only story that audits cli-engine.ts and writes a dedicated execution plan. This avoids risky broad text replacement in a large CLI entrypoint while still giving reviewers a concrete translation map and migration order.

## Conversational Texture
The user agreed with the English-only open-source cleanup direction and explicitly asked for a detailed execution document with every Chinese translation result for review. The expected outcome is a committed Markdown document the user can inspect before approving implementation.
