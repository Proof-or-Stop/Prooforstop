## Trigger Event
On 2026-06-15, while preparing Lattice for open-source release (immediately after story B-d313 and the discarded B-15d2), an audit of packages/ and tracked root files found dead sample projects and committed junk. The user flagged packages/cli-guess-number, packages/python-demo, and packages/python-rps as unused and asked what else is dead.

## Key Insights
Reference scans confirmed: cli-guess-number is referenced only by its own package.json; python-demo and python-rps have zero external references and no package.json (dogfood samples with their own koala.config.json). The test:authority-live-python* suites build their own temp job under tmpdir()/lattice-live-python-job and do NOT use these folders. du.exe.stackdump is a Windows du.exe crash dump; claude-session.mjs is a dead prototype superseded by packages/main/src/providers/claude-cli.ts (nothing imports it). jek.md is user-owned and protected by decisions/root-markdown-migration-execution-solution.md, so it is explicitly KEPT and never a deletion target here.

## Solution Tradeoffs
Delete the five confirmed-dead paths and scrub residual references. jek.md is excluded by design because a decision doc mandates keeping it unless the user explicitly requests removal, and the user chose to keep it. packages/lab is kept and the experiments/ data-drop is deferred to a separate, more surgical story because that change must preserve files consumed by verify-real-story-replay-benchmark and lab storage.

## Conversational Texture
The user is personally driving the open-source launch and wants the repo tidy; they confirmed 'keep lab, drop committed data', 'one cleanup story now', and explicitly chose to keep jek.md when shown its protection rule. The priority is shipping only the real Lattice product, not the toy projects it was tested against, without touching user-owned files.
