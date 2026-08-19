## Trigger Event
On 2026-07-07, after Cell03 reached 1142/1152 final rows, a consecutive usage-limit contamination window was identified for indices 506-515. The user explicitly approved a safe targeted rerun entry so those rows could be corrected without polluting the entire Cell03 dataset.

## Key Insights
The right evidence model is append-only: preserve the original failed attempts as audit evidence, append attempt-3 rows only for the approved contaminated range, require targeted rerun provenance, and prove the final Cell03 dataset with validators rather than rerunning the full provider campaign.

## Solution Tradeoffs
A new provider campaign would waste time and risk changing the experiment. A bare commit would leave memory and story provenance missing. A narrow retroactive DONE story records the already completed correction, links validators and external paper mirror synchronization, and keeps Cell06, Phase2, and paper conclusions out of scope.

## Conversational Texture
The user wanted the fastest clean path: no duplicate computation, no hidden dirty Cell03 data, and no false claim that the correction was part of the Cell06 story. This story exists to make that boundary visible to future agents and paper work.
