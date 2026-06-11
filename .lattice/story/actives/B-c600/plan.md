# B-c600 Plan

## CHK-001

Add a pkg-based desktop packaging pipeline around the full `bin/koala.js` bootstrap. The implementation will add a small release script that builds `packages/main`, `packages/utils`, and `packages/lab`, invokes Vercel `pkg` with an explicit config/entrypoint, and writes artifacts under `dist/desktop/`. The config must include dist JavaScript, templates, local wrappers, and package metadata that the bootstrap reads at runtime. Host packaging is the local fast path; multi-platform targets are available for release builds.

## CHK-002

Add a focused verifier that runs the generated executable itself, not just Node source. The verifier will locate the current host artifact, fail with a direct recovery message if it is missing, execute lightweight CLI commands such as `status --help` and `aux_doc_list --help`, and reject bootstrap/module loading errors. This proves the packaged artifact contains the full bootstrap surface and catches missing snapshot assets.

## CHK-003

Document the desktop binary workflow in README. The docs will show maintainers the exact host build/smoke commands, the release command for macOS/Windows/Linux outputs, where artifacts are written, and how desktop packaging should carry those binaries. The section will explicitly state that Vercel `pkg` is deprecated with 5.8.1 as the last release, so this is an early deployment path rather than the final long-term runtime packaging strategy.
