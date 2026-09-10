# U-09 runtime read path normalization

The real executor emitted absolute read paths, while the closure catalog uses repository-relative source paths. Internal JSON/configuration reads therefore made the canonical baseline uncertifiable. RED commit `e6b4bd4189` pins `node scripts/verify-runtime-trace-paths.mjs` against eight actual subprocess reads.

The repair records physical read paths at call time and carries a versioned trace schema through the executor. The closure mapper checks repository containment before mapping generated JavaScript to source. Child cwd changes and subsequent symlink retargeting cannot rewrite the recorded observation. Unsupported/legacy/malformed fragments and unresolved filesystem inputs remain unknown. This is call-time path observation, not atomic kernel read provenance.

The pinned regression now retains the original eight checks and adds three temporal path cases and three malformed/legacy fragment cases. Independent execution passed all 14 cases. The build, runtime fact contract and tracer promisify transparency check passed. The process contract also checks the new trace evidence contract and follows the extracted Story Git reader when checking NUL framing.

Independent joint review/validation comparison reduced prompt bytes from 29,944 to 25,529 (14.74%) and made the full-baseline authority prerequisites pass. Both full and dynamic execution caught the same defect. However, dynamic still executed all three commands: historical receipt admissibility compares its clean-tree digest to the current HEAD. This is a separate remaining U-09 repair; these path results do not establish command-count savings.

The old standalone production smoke did not reach tracer assertions: its fixture writes the retired `lattice.config.json`, so configured commands are empty. This run is a failed fixture check, not acceptance evidence. No formal Story DONE or product release is claimed.
