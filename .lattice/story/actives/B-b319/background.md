## Trigger Event
During B-022e on 2026-08-31, the direct validation-protocol smoke failed after canonical managed markers were corrected because its root PROOF_OR_STOP.md fixture no longer selected the current managed guide path.

## Key Insights
The local-edit safety assertion remains valuable, but it must target a path that the selected asset mode actually manages. Otherwise the test observes unrelated MISSING or STALE_SAFE items and cannot prove that apply preserves local edits.

## Solution Tradeoffs
The follow-up should first define which guide path is authoritative for each asset mode, then move the fixture without weakening STALE_LOCAL_EDIT protection. It must not make every legacy guide name active merely to satisfy the old assertion.

## Conversational Texture
This was intentionally deferred from the identity cutover because the canonical marker production path is already verified. The remaining failure concerns managed-path selection and deserves a focused Story with direct mode-matrix evidence.
