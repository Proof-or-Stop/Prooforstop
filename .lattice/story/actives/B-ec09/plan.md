# B-ec09 Plan

Milestone 1 scope only: harden the Koala CLI authority trust boundary so the CLI can orchestrate workflow and local/shadow evidence, but cannot claim or certify L2+ production authority without a future Runner/Python receipt-backed track.

## Reviewer advisory absorption

- `L2+ authority` means production-grade authority evidence backed by independent actor/run identity, runner/provider metadata, command/transcript/diff bindings, and a Python authority server receipt. Koala CLI currently lacks those fields by design under PD-1.
- CHK-003 user-visible surface will be a focused smoke command, preferably `npm run test:authority-boundary-smoke`, or an equivalent output wired into the existing authority smoke suite. The expected visible pass line must include `CLI evidence is local/shadow/thin-client, not receipt-backed L2+ authority` or equivalent.
- CHK-004 routing lands in this story's DONE summary plus the durable PD-1 authority-client role document. Milestone 2 remains owned by the Koala Runner/Mac repo and must not be auto-opened here.
- The seven milestone routing remains: M1 CLI boundary hardening (this story), M2 Runner CLI in Mac/Runner repo, M3 CLI runner client, M4 shared evidence contract, M5 authority-backed DONE receipt gate, M6 red-team integration tests, M7 unified `koala dev_start` entrypoint.

## CHK-001 — Authority trust boundary truth source is explicit and non-overclaiming

Implementation:
- Update `docs/requirements/decisions/authority-client-role.md` with a concise trust-boundary section naming three roles: Koala CLI as workflow client, Koala Runner CLI/Mac runner as execution plane, Python Authority as receipt authority.
- Add the cold-read definition of L2+ authority and explicitly state that colocating CLI and runner in one repo/package does not make evidence authoritative.
- Keep this as a minimal documentation update; do not modify Mac/Python repos.

Verification:
- `rg` checks for the three-role language, the L2+ definition, and the no-overclaim statement.
- Evidence kind: `docs_check` for CHK-001 happy/edge/adversarial.

## CHK-002 — CLI authority submission contract labels thin-client evidence as non-authoritative

Implementation:
- Add a small code-level classification helper or contract field in the authority client/submission area that mechanically labels CLI authority submissions as thin-client/local-shadow unless future receipt-backed requirements are present.
- Ensure the accepted-only transport path is named/typed as transport acceptance, not server receipt verification.
- Keep `off` and `shadow` behavior compatible; do not implement full EvidenceEnvelope FU-1/FU-2/FU-3.

Preferred touchpoints:
- `packages/main/src/core/authority-contracts.ts`
- `packages/main/src/core/authority-submit.ts`
- optional new `packages/main/src/core/authority-boundary.ts` if cleaner.

Verification:
- Focused smoke test asserts missing run bindings/provider/model/vendor/hash/receipt cannot classify as production L2+.
- Existing authority smoke tests continue to pass.

## CHK-003 — Gate and status surfaces warn before CLI-only authority overclaim

Implementation:
- Add a focused smoke command, likely `test:authority-boundary-smoke`, that prints a user-visible pass line for the boundary classification.
- The command should cover local/off usability, shadow/enforce accepted-only wording, and an adversarial forged/local-only success path that remains non-receipt-backed.
- Update `package.json` and `packages/main/package.json` scripts if a new task is added.

Expected visible output:

```text
✓ authority boundary smoke passed: CLI evidence is local/shadow/thin-client, not receipt-backed L2+ authority
```

Verification:
- Run the new smoke command.
- Run existing authority evidence flow smoke to guard behavior compatibility.

## CHK-004 — Milestone 1 validation and next-milestone routing are recorded

Implementation:
- Record in the durable doc and DONE summary that this story completes only Milestone 1.
- Explicitly route M2 to Koala Runner CLI / Mac Runner repo, M3-M7 to future stories, with no automatic story creation here.
- Verify scope: no external repo changes, no Mac/Python changes, no full runner implementation.

Verification:
- `git status` on this repo and read-only status checks for Mac/Python if needed.
- Scope contract check passes.
- Story summary and transcript-diff state `audit/feature boundary hardening only` and next owner.

## Expected validation commands

```bash
npm run build
npm run test:authority-boundary-smoke
npm run test:authority-evidence-flow
npm run test:authority-client
koala scope_contract_check --storyId=B-ec09 --json
koala validate --story=B-ec09 --json
```
