# B-4eea Real-Machine Transcript Diff

## Expected

- Runtime memory consumers surface advisory MemoryFreshnessPack output without becoming gate evidence.
- Host handoff/dispatch accepts Codex CLI and Claude Code CLI as primary hosts, and only accepts agy-cli after a concrete primary-host failure signal.
- Handoff target host aliases are normalized to capability ids before reaching handoff/dispatch registries.
- Baseline generation refuses unsafe overwrites unless `force=true`.
- Baseline verification rejects stale or incomplete corpora, including tampered `gold-queries.json`, truncated self-consistent manifests, requested profile mismatch, and wrong full-profile flags.
- Generated verifier temp directories are cleaned by default.

## Actual Commands Run

```text
npm --prefix packages/main run build
node packages/main/dist/tasks/playbook-runtime-memory-baseline-smoke.js
node packages/main/dist/tasks/playbook-runtime-memory-baseline-smoke.js --profile=full
node packages/main/dist/tasks/playbook-runtime-memory-mvp2-smoke.js
node packages/main/dist/tasks/playbook-runtime-memory-health-smoke.js
node packages/main/dist/tasks/playbook-runtime-memory-mvp1-smoke.js
node packages/main/dist/tasks/command-catalog-smoke.js
node scripts/verify-process-fact-contract.mjs
node scripts/verify-runtime-fact-contract.mjs
lattice validate --story=B-4eea --json
```

## Actual Results

- Build passed.
- Small baseline smoke passed with `recordCount=1000`.
- Full baseline smoke passed with `recordCount=1000000` and `fullProfileExactMillion=true`.
- MVP2 smoke passed `TOTAL 9 | PASS 9 | FAIL 0`, including unknown primary target normalization to `codex` and agy-cli fallback rejection without `primaryHostFailure`.
- Health smoke passed.
- MVP1 smoke passed `TOTAL 11 | PASS 11 | FAIL 0`.
- Command catalog smoke passed with `291 commands`.
- Process fact contract verified.
- Runtime fact contract verified.
- TEST-stage `lattice validate --story=B-4eea --json` passed all 31 configured commands.

## Diff Notes

- No observed behavior diverged from expected behavior.
- The only notable runtime characteristic is the full 1,000,000-record baseline memory footprint: the final local run reported roughly 835 MB RSS. This remains report-first performance evidence, not a blocking performance gate.
- Memory runtime output remains explicitly non-authoritative: `authority=non_authoritative` and `gateEvidence=false`.
