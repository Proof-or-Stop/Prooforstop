# Plan — B-35aa: A0 test-runner consolidation decision doc

## Goal
Produce a permanent decision document at `docs/requirements/decisions/test-runner-consolidation-plan.md`
that locks in path B (in-house parallel runner + manifest + c8 coverage) for the test-runner
consolidation sub-program, and decomposes implementation into 3-4 follow-up Lattice stories.

This is an A0 (kickoff/decision-only) story. **Zero code, zero existing-decision-doc edits.**

## CHK-001 — Write the decision doc
Create `docs/requirements/decisions/test-runner-consolidation-plan.md` with 4 required sections:

### Section 1: Current state
Pin the numbers measured at story-creation time (2026-06-17):
- 151 `*-smoke.ts` files (~70,280 lines; ~466 avg; max 3,831 lines flow-stability-smoke).
- 258 `test:*` npm script entries (111 root + 147 packages/main).
- 49 `scripts/verify-*.mjs`.
- Smokes execute via `node packages/main/dist/tasks/<name>-smoke.js` (dist-standalone-executable pattern).
- Existing constraints: testing-infra.md (project-native validation + general-black-box-command); testing-completeness.md (@flow / @test contract).

### Section 2: Paths considered
- **A — Vitest migration**: rewrite 151 smokes into `describe/it`; adopt vitest runner. PROS: ecosystem, IDE integration, parallelism. CONS: 70k-line rewrite cost; smokes are spawn-CLI integration scenarios, not vitest's sweet spot; conflicts with testing-infra.md's project-native validation policy (vitest is JS-only, the project's policy is language-agnostic black-box).
- **B — In-house parallel runner + manifest + c8 (chosen)**: write a small TS runner that scans `*-smoke.ts`, reads a manifest controlling parallelism/tags/select/timeout, exposes `test:all` `test:tag <tag>` `test:select <pattern>`, and wraps c8 for coverage. PROS: preserves 70k existing lines; aligns with testing-infra.md; delivers parallelism + coverage + UX simultaneously. CONS: maintain an in-house runner.
- **C — B minus c8**: same as B without coverage. PROS: smaller scope. CONS: misses one of the three stated benefits; c8 wiring is trivial.

### Section 3: Chosen path = B; rationale
Smokes are spawn-CLI integration scenarios (`mkdtempSync` + `execFileSync('node', ['dist/cli.js', ...])`),
not unit tests. The dist-standalone-executable pattern is a deliberate architectural choice:
it mirrors what an OSS user does when running the published CLI. testing-infra.md's project-native
validation policy is "use the project's own validation commands"; vitest would mean adopting a
JS-only framework as the validation contract, conflicting with that policy. Path B wraps the
existing architecture without rewriting it.

### Section 4: Follow-up Lattice stories
Each follow-up story goes through its own INIT→DONE Lattice workflow. One-paragraph scope sketches:

- **B1 — Runner skeleton + manifest format + `test:all` entry**: write
  `packages/main/src/tasks/run-all-smokes.ts` (and dist artifact) that scans `*-smoke.ts`,
  reads a manifest TSV/JSON controlling parallelism (default = cpu cores), per-smoke timeout,
  and optional tags. Add `test:all` npm script at root. Acceptance: `npm run test:all` runs every
  smoke and reports per-smoke pass/fail + summary; running with `--tag <tag>` or `--select <pattern>`
  filters; existing individual `test:*` scripts unchanged.

- **B2 — Collapse 258 `test:*` scripts into manifest entries**: mechanical migration. For each
  individual `test:*` entry, add a row to the manifest (script-name, tag(s), timeout). Remove the
  individual npm script. Keep a thin compatibility layer if any external doc/script references the
  removed names. Acceptance: root + packages/main `test:*` count drops from 258 to a small set
  (`test:all` + a handful of orchestration entries); `npm run test:all` exits 0 byte-identical to
  the prior batch behavior; CHANGELOG documents the removal.

- **B3 — c8 coverage instrumentation + `test:coverage` entry**: wrap the runner in c8 (per
  c8 docs); `npm run test:coverage` runs all smokes under c8 and emits coverage/ HTML + LCOV.
  Acceptance: HTML coverage report opens; LCOV file generated; CI integration optional.

- **B4 (optional) — Tag/select UX improvements**: dev ergonomics — `npm run test -- --tag wrapper-root`,
  `--select "*-smoke"`, watch mode, etc. Acceptance: documented in CONTRIBUTING.md.

### Closing
The decision doc itself is NOT load-bearing for any gate; it is a one-time architectural commit.
B1-B4 each go through full Lattice workflow; B1 should be the next story after this one.

## Out of scope
Any runner code, any smoke edits, any package.json edits, any c8 wiring, any edits to existing
decision docs (testing-infra.md / testing-completeness.md remain untouched).
