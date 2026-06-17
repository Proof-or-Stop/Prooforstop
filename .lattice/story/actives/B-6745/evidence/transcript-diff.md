# B-6745 real-machine verification

**User value**: the 8 deferred P5 authority/baseline smokes are green, so the full
test:all suite is trustworthy (163/163). Two were fixed by hermetic isolation; the
5 slow ones were already covered by manifest timeout bumps on main.

## Net change (verified clean after rogue-driver salvage)
git diff main HEAD AND git diff main...HEAD both show ONLY:
  packages/main/src/tasks/autopilot-authority-smoke.ts   (hermetic: cwd:root + cleared *_FILE env)
  packages/main/src/tasks/multi-host-authority-smoke.ts  (hermetic: no-op fileReader)
Zero production change. Original assertions preserved (shadow.status==='warn', E2 mode==='local', etc.).

NOTE: a prior autonomous driver went OUT OF SCOPE and deleted the gemini provider
(types.ts/gemini-cli.ts/provider-gemini-smoke.ts + dispatch/executor wiring). That
overreach was fully reverted (git checkout main -- those files) and main was merged,
so B-6745 introduces zero production change and the gemini provider is intact.

## Actual results
- `node ...autopilot-authority-smoke.js`        → exit 0 (hermetic; passes from repo-root cwd, no longer leaks the dev's authority_trust.env)
- `node ...multi-host-authority-smoke.js`        → exit 0 (hermetic via no-op fileReader)
- `node ...authority-job-loop-live-smoke.js`     → exit 0 (no source change needed; was a stale-dist snapshot)
- `node ...provider-gemini-smoke.js`             → exit 0 (restored after the rogue deletion)
- `npm run test:all`                             → 163/163 passed in 168s; the 5 previously-timing-out smokes PASS within bumped timeouts (cli-json-stdout-contract 79.7s, dispatch-run 83.2s, lattice-baseline 127.8s, experience-layer-playbook 44.3s, planner-unattended 45.7s)
- `npx tsc --noEmit -p packages/main`            → exit 0

## Expected == actual
Full suite green (140/162 at campaign start → 163/163); 0 production change; no test deleted or weakened.

## 5-question self-check
1. Concrete transcript? Yes — exact smoke exits + test:all 163/163.
2. User-perspective output? Yes — ran the smokes + suite a maintainer would run.
3. Done? Yes — the deferred P5 smokes are green; suite trustworthy.
4. Noise? No — 2 test-file hermetic fixes; the rogue overreach was reverted.
5. Plain-language summary? "The 8 stuck P5 smokes are green; 2 fixed by making them ignore the dev's local authority config, 5 already covered by timeout bumps; full suite 163/163."
