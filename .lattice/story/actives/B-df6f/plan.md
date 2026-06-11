# Plan

## CHK-001
**Owner**: main-agent

Update the shared story metadata classifier in `packages/main/src/core/evidence-freshness.ts` so Koala metadata prefixes are matched after slash normalization and case normalization. Check whether `packages/main/src/handlers/validate-channel.ts` has a duplicate helper; either delegate to the shared classifier or apply the same path normalization so metadata-only Koala commits do not regress in legacy channel fallback. Keep the prefix list narrow: `.koala/story/`, `docs/story/`, and `docs/koala/framework-audit/`.

Verification focus: uppercase `Docs/story/actives/...` must be metadata-only for freshness and dirty gate, while `docs/requirements/...` and source files remain material.

## CHK-002
**Owner**: main-agent

Extend existing smoke tests rather than introducing new harnesses. Add uppercase `Docs/story/actives/...` examples to `verification-freshness-smoke` metadata-only coverage and dirty-classifier coverage. Preserve or add material assertions showing real source/package/config/docs requirements changes remain stale. Run focused build and smoke tests, then record verificationEvidence against every intent before TEST.

Verification focus: `npm --prefix packages/main run build`, `npm --prefix packages/main run test:verification-freshness-smoke`, and the focused dirty-gate smoke path that covers classifier behavior.
