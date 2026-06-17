# B-1dc9 Execution Plan — Experience Layer Phase 1.5 (advisory hint injection)

Surface derived finding-signals as advisory review-time hints. Advisory-only;
hints never affect the deterministic reviewRunId promptHash. Mirror grillSection.

## CHK-001 experience-hint-loader (rank/filter/format)
`core/experience-hint-loader.ts`: read finding-signals.json via learning-store.
priority = signalScore*log(1+support)*recencyBoost. Recurring-issue hints require
signalScore>=0.65; low-score + high-false-positive => common_false_positive hints.
top-N: <=3 recurring + <=2 false-positive. Progressive disclosure: a short summary
line per hint (score + support + source), full detail on demand. Imports only
learning-store (read) + experience-layer-types + node:. Deterministic given inputs
(no Date.now in the pure ranking; accept an injected now for recencyBoost).
Verification: smoke asserts ranking order, score threshold, false-positive bucket,
top-N cap, support shown.

## CHK-002 Advisory section in story-review (mirror grillSection)
`handlers/story-review.ts`: add an experienceHintsSection sourced from the loader,
placed in the advisory _reviewPrompt next to grillSection, labelled
"Project experience hints (advisory only)". Present when signals exist; omitted
when none. Advisory-only; no gate change.
Verification: smoke asserts the section appears/omits correctly in _reviewPrompt.

## CHK-003 Usage tracking + promptHash guardrail
On surface, append exactly one experience_hint_surfaced event (storyId, hintIds)
to the activity log via appendActivityLog. GUARDRAIL: resolveReviewPromptHash
(core/review-run.ts) stays independent of hint content — hints never feed it.
Verification: smoke asserts the event is appended once per surface; and that
resolveReviewPromptHash(prompt) is byte-identical regardless of experience-hint
content.

## CHK-004 Smoke + npm script + no regression
`tasks/experience-layer-hint-injection-smoke.ts` + package.json
`test:experience-layer-hint-injection`. Hermetic. Assert all of the above plus
zero outward imports (loader), build clean, and existing experience-layer +
story-review smokes still pass.
Verification: npm script exits 0 'smoke passed'; verifier TOTAL N | PASS N | FAIL 0.

## Out of scope
Review-gate code; the staged playbook proposal lifecycle (Phase 2); cross-project
aggregation (Phase 4); any change that puts hint content into resolveReviewPromptHash.
