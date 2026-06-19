## Trigger Event
B-0717 documented cli-engine.ts as a god file and the 2026-06-19 user request asked to start development with concurrent stories. Runtime root/activity/ownership gate code is a cohesive region that can be separated from command catalog and help parsing.

## Key Insights
This slice touches gate-consumed process facts and reviewer safety, so it is higher risk than pure help extraction. It should preserve mechanical enforcement exactly and update process/runtime contract checks if any gate evidence semantics move.

## Solution Tradeoffs
Extracting runtime and ownership gates as one story gives reviewers a coherent safety boundary. The tradeoff is that it may need to wait for B-74a0 imports to settle, but its write set should be mostly separate from help and alias work.

## Conversational Texture
The user wants stronger future capability, not just fewer lines. This slice targets the safety-critical portions that make multi-host work reliable: root selection, activity source, owner lease, and reviewer gates.
