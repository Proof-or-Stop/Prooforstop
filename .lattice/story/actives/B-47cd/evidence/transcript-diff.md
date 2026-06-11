# B-47cd Transcript Diff

## Expected

Lattice exposes unattended host-to-host development as policy-gated CLI flows:

- Conservative mode can dispatch, validate, and review work, but remains manual-only for merge and DONE.
- Authority-Verified mode can consider integration only when server authority receipt gates pass.
- Full Autopilot mode is bounded by max iterations, runtime, budget, scope, conflict, and authority rules.
- Host-native delegation and Lattice-controlled dispatch both produce reviewable handoff, transcript, receipt, and merge-plan evidence.
- Local diagnostic receipts must not claim `receiptVerified=true` or `productionDone=true`.

## Actual

The refreshed TEST run on HEAD `4f9e825d79858c3ef6e285c11a84815433f52897` matched the expected user-visible behavior:

- `npm --prefix packages/main run build` passed.
- `npm --prefix packages/main run test:autopilot-run-smoke` passed and covered registration, two-policy linkage, policy gates, strict CLI flag refusal, owner-gated cancel/resume, forged authority refusal, fully-shaped public server receipt refusal, fake-test authority isolation, bounded retry, budget fail-closed, conflict evidence preservation, host-native delegation, cancel evidence preservation, resume refusal, and authority boundaries.
- `npm --prefix packages/main run test:dispatch-run-smoke` passed and covered runtime probes, overflow gating, real-host scaffolds, receipts, degradation paths, manual merge guidance, authority invariants, dispatch policy contract, real-host unattended capability contract, runner details, scheduler controls, and evidence review/merge gates.
- `npm --prefix packages/main run test:unattended-dispatch-smoke` passed and covered policy checks, Claude Code capability probe, fake parallel dispatch, policy-bound fake Claude success/env/nonzero/timeout coverage, dispatch watch/cancel/review/merge-plan behavior, unsafe host refusals, denied env filtering, missing receipt, mixed diagnostics, and overflow migration guidance.
- `npm --prefix packages/main run test:command-ownership-contract` passed for 179 commands, including autopilot policy ownership classification and owner-gated commands.
- `npm --prefix packages/main run test:flow-stability-smoke` passed.
- `npm --prefix packages/main run test:remote-push-approval-smoke` passed.
- `node packages/main/dist/tasks/done-preflight-smoke.js` passed.
- `node bin/lattice.js validate --story=B-47cd --json` passed with `allPass=true` and 33/33 verification intents covered.
- `node bin/koala-codex.js verify_codex` passed 7/8 checks; the only advisory is global fallback heartbeat resolving to the main package path rather than the story worktree, which is expected and not used as gate evidence.

## Difference

No user-visible acceptance gap remains. The only residual notes are intentional boundaries: Conservative mode is manual-merge, Authority-Verified mode requires server authority receipt, Full Autopilot remains bounded, and Lattice still does not claim production authority from local diagnostic receipts.
