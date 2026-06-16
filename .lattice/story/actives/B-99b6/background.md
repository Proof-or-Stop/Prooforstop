## Trigger Event
2026-06-16: While closing B-3990, the test-coverage reviewer raised F-001 — the new test:bare-gate-gitroot-cwd smoke passes when run directly but is not in any lattice validate path, so a regression would go uncaught. It was dismissed as out-of-scope (the gap is shared with B-198c and B-2856 smokes that already reached DONE the same way). The user asked to open a dedicated infra story to close it pattern-wide.

## Key Insights
Root package.json: test = npm run test:e2e (node packages/main/dist/tasks/cli-e2e.js). lattice validate's fallback runs npm test, so only cli-e2e runs. The wrapper-root / gitRoot smokes (storydir-inside-gitroot-smoke/suite, gitroot-cwd-routing, bare-gate-gitroot-cwd) and the authority/evidence smokes are all standalone test:* scripts that nothing aggregates. They build real temp git fixtures and assert real behavior; they just aren't run by validate.

## Solution Tradeoffs
Option A: add a test:smokes aggregator script that runs the relevant smokes and chain it into the root test script (test = test:e2e && test:smokes), so validate runs them. Simple, no config change. Option B: add a validate.command to lattice.config.json so validate runs an explicit battery. Option C: a per-tag discovery convention. Lean A or B; keep it minimal and make a smoke failure block validate. Decide which smokes belong in the fast validate path vs a slower --full path (some build git fixtures and may be slower).

## Conversational Texture
Direct follow-up to B-3990:F-001 in this session. The goal is to remove regression-blindness for the wrapper-root gitRoot fixes (B-198c, B-2856, B-3990) by making lattice validate actually run their smokes.
