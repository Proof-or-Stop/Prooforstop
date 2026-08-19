# Plan: B-7438 Require Host Availability Proof Before Degraded Fallback

## CHK-001

Add a durable host availability probe for review fallback decisions. The command will be `review_host_availability_probe` and will run local checks for the canonical host commands `codex`, `claude`, and `agy`. It records a process event with a probe id, materialHash, storyFilesHash when available, checkedAt timestamp, host rows, availableHostCount, and local-only assurance flags held false for Authority/production. Register the command/fact in the process fact registry and command policy so contract verification covers it.

Implementation notes:
- Probe command lookup and version internally; do not accept caller-supplied host status as proof.
- Treat missing command/path/version failure as an unavailable host row, not an omitted row.
- Keep this evidence diagnostic/local and explicitly non-Authority.

Verification:
- Build and smoke tests assert three canonical rows and event persistence.
- `node scripts/verify-process-fact-contract.mjs` covers registry/contract drift.

## CHK-002

Tighten degraded fallback validity in both the write path and evaluator paths. For `single-host-environment` and `temporary-host-unavailability`, require a fresh probe event bound to the current materialHash. If that probe shows two or more canonical hosts executable, reject the fallback with a user-facing message telling the operator to use full 3x2 or `explicit-human-approval`. Keep `explicit-human-approval` available only with approvalRef/evidence and continue reporting `assuranceLevel=degraded-single-host`.

Implementation notes:
- `review_escalation_fallback_set` should fail before writing an invalid fallback event.
- `evaluateReviewEscalation` and `evaluateReviewAssuranceFloor` should also mark manually injected or legacy fallback events invalid when the required probe is missing, stale, or contradictory.
- Do not report degraded fallback as full 3x2 or production/Authority completion.

Verification:
- Logic smoke covers insufficient-host probe pass, two-host probe reject, missing probe reject, stale probe reject, and explicit-human-approval lower-assurance pass.

## CHK-003

Extend the existing review escalation and review assurance floor smoke tests so the user-visible diagnostics are pinned. The tests should prove that the exact Proof-or-stop failure mode is now impossible: prose-only evidenceRefs cannot satisfy single-host scarcity, and a machine with two executable canonical hosts cannot claim `single-host-environment`.

Implementation notes:
- Prefer extending existing smoke tests rather than creating a broad new test harness.
- Include assertions on rendered/status reasons so operators see how to recover: run the host probe, collect full 3x2, or explicitly choose human-approved degraded fallback.

Verification:
- `node packages/main/dist/tasks/review-escalation-smoke.js`
- `node packages/main/dist/tasks/review-assurance-floor-smoke.js`
- `npm --prefix packages/main run build`
- `node scripts/verify-process-fact-contract.mjs`
