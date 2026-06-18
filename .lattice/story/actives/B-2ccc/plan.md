# B-2ccc Execution Plan — extract canonical-JSON-digest into core/digest.ts

Behaviour-preserving refactor before Phase 2. Move the digest primitives from
handlers/decision-doc-promotion.ts into a leaf core/digest.ts; re-import them.
All digest VALUES stay byte-identical.

## CHK-001 Create leaf core/digest.ts
New packages/main/src/core/digest.ts exporting Digestable, canonicalJson,
digestCanonicalJson, digestText (and normalizeJson if needed), extracted verbatim
from decision-doc-promotion.ts lines ~64-88. Imports only node:crypto.
Verification: build clean; smoke asserts the digest functions produce byte-identical
output to a pinned set of inputs (matching pre-refactor values).

## CHK-002 Refactor decision-doc-promotion.ts to import from core/digest.ts
Replace the inline definitions with `import { ... } from '../core/digest.js'`;
remove the now-duplicated local definitions. computeDecisionDocProposalDigest and
digestDecision produce identical values. No behaviour change.
Verification: decision-doc-promotion imports from ../core/digest.js; existing
decision-doc behaviour/smoke unchanged; no digest value changes.

## CHK-003 Smoke + npm script + no regression
tasks/experience-layer-digest-extract-smoke.ts + package.json
test:experience-layer-digest-extract. Assert: digest byte-identical on pinned
inputs; computeDecisionDocProposalDigest stable; build clean; existing
decision-doc + experience-layer smokes still pass.
Verification: npm script exits 0 'smoke passed'; verifier TOTAL N | PASS N | FAIL 0.

## Out of scope
Any digest output/hashing-scheme change; decision-doc behaviour changes; the
playbook lifecycle (Phase 2); reviewer-prompt hint wiring.
