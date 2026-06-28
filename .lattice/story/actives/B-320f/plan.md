# B-320f Plan: Complete Autopilot v2 Reliability M2-M4

## CHK-001
**Owner**: main-agent
**Goal**: Close the reproduced M2-M4 gap as a single auditable delivery: code, docs, tests, and final acceptance table all agree.
**Steps**: Implement the focused reliability primitives, wire needed Autopilot projections, update the execution plan, run dedicated and regression smokes, then record verification evidence per item.
**Verify**: The final table says the reproduced gap is closed, candidate repro evidence remains intake-only, and green evidence comes from build/smoke/validate commands.
**Risk**: Do not turn candidate repro artifacts into DONE evidence or Authority proof.

## CHK-002
**Owner**: main-agent
**Goal**: Implement M3 adaptive runtime throttle semantics.
**Steps**: Add a bounded throttle state machine with maxConcurrentLive clamping, live permit accounting, stable-window raise, and overload/rate-limit backoff events.
**Verify**: node packages/main/dist/tasks/autopilot-v2-reliability-smoke.js asserts maxConcurrentLive enforcement, throttle_hold, throttle_raise, throttle_backoff, and safe clamping.
**Risk**: The throttle is a local control-plane proof; it must not claim live multi-day fleet proof.

## CHK-003
**Owner**: main-agent
**Goal**: Implement M4 process-pool claim lease and fencing semantics.
**Steps**: Add atomic claim/lease/fencing primitives suitable for the future OS-process pool: ownerWorkerId, leaseId, leaseExpiresAt, fencingToken, duplicate claim refusal, takeover after expiry, and stale commit refusal.
**Verify**: The dedicated smoke asserts distinct workers claim distinct units, duplicate pending claims are refused, expired leases can be taken over, and old fencing tokens cannot commit.
**Risk**: Done checkpoints prevent replay after completion; claims/fencing prevent duplicate pending execution before completion.

## CHK-004
**Owner**: main-agent
**Goal**: Update the Autopilot v2 execution-plan document from stale PLANNED status to a current milestone ledger and acceptance table.
**Steps**: Mark M1 done via B-c7e2, M2-M4 completed by B-320f once tests pass, list scripts/commands, and explicitly describe local deterministic proof boundaries.
**Verify**: The doc no longer says the whole program is PLANNED/backlog, does not claim process immortality, and does not reintroduce Authority Server production receipt claims.
**Risk**: Keep live provider fleet / multi-day powered campaign proof separate from local control-plane proof.

## CHK-005
**Owner**: main-agent
**Goal**: Run build/smoke validation and bump the CLI patch version after runtime behavior changes.
**Steps**: Build packages/main, run the new Autopilot v2 reliability smoke, rerun existing Autopilot M1/run smokes, record verification evidence, run lifecycle validation, complete DONE, then bump version on main if required by the project rule.
**Verify**: Commands include npm --prefix packages/main run build, node packages/main/dist/tasks/autopilot-v2-reliability-smoke.js, node packages/main/dist/tasks/autopilot-resume-smoke.js, and node packages/main/dist/tasks/autopilot-run-smoke.js.
**Risk**: Version bump must happen once for runtime behavior changes and should not include unrelated untracked experiment artifacts.

## CHK-006
**Owner**: main-agent
**Goal**: Implement M2 health-aware pause/resume semantics.
**Steps**: Add provider failure classification for current hosts, define transient vs terminal categories, project waiting_for_provider_health and paused_requires_resume states/events, and expose watch/resume guidance without launching unsafe workers.
**Verify**: The dedicated smoke asserts 429/network/timeout are transient, auth/quota/policy/terminal errors are not transient, watch projection emits health_probe/provider_unhealthy/waiting/paused/health_recovered/resumed, and gemini stays legacy-only.
**Risk**: Health pause/resume is restart-safe control-plane behavior, not process immortality; a host/supervisor/human still relaunches after process death.

## CHK-007
**Owner**: main-agent
**Goal**: Integrate the reliability primitives across Autopilot core without replacing M1.
**Steps**: Keep M1 ledger-resume intact, add additive exports/projections, and avoid live provider calls in deterministic tests.
**Verify**: The dedicated smoke and existing Autopilot smokes pass; local authority/production flags remain false.
**Risk**: Integration must stay additive and fail-closed.

## CHK-008
**Owner**: main-agent
**Goal**: Produce the final verification report mapping features to commands and tests.
**Steps**: Update the document table and final response table with each feature, script, command, and PASS/scope note.
**Verify**: The final table distinguishes direct Autopilot-v2 scripts from DONE/review gate scaffolding and names remaining live-fleet limitations.
**Risk**: Do not collapse local smoke proof into live powered-campaign proof.
