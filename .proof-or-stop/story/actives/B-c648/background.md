## Trigger Event
The B-3783-style failure, now concretely isolated in B-fb7b, showed that a Story can be opened around a plausible but false premise: validate built only main, while the real failing consumer was root npm test reaching bin/lattice.js and requiring utils/dist. The user requested a framework-level prevention mechanism on 2026-08-14.

## Key Insights
Existing Repro-First evidence proves that a failure is real, while verificationIntent and acceptance topology prove planned and executable acceptance paths only after a Story exists. The missing guarantee is a mandatory, review-bound proof of entrypoint, consumer chain, existing mechanisms, authoritative hook, and minimal change before Story ID allocation.

## Solution Tradeoffs
The design should extend the current STORY_INTAKE candidate-evidence, draft-review, and central story_create choke point. A new lifecycle phase or independently writable truth source would duplicate authority. Enforcement should roll out shadow to warn to enforce, and remain candidate-only until story creation.

## Conversational Texture
The user repeatedly challenged whether Proof-or-Stop already solved this class of mistake and asked for a concrete detailed answer. The document must therefore distinguish reusable architectural ingredients from the missing mechanical gate, show exactly where stopping occurs, and demonstrate the result with the root npm test example rather than rely on abstract process language.
