## Trigger Event
On 2026-06-15, while preparing Lattice for open-source release (immediately after story B-d313), an audit of packages/ and tracked root files found dead sample projects and committed junk. The user explicitly flagged packages/cli-guess-number, packages/python-demo, and packages/python-rps as unused and asked what else is dead.

## Key Insights
Reference scans (grep across the repo excluding node_modules/.git/.worktrees/dist/.lattice) confirmed: cli-guess-number is referenced only by its own package.json; python-demo and python-rps have zero external references and no package.json (each is a dogfood sample carrying its own koala.config.json). The test:authority-live-python* suites build their own temp job under tmpdir()/lattice-live-python-job and do NOT use these folders. Separately, du.exe.stackdump is a Windows du.exe crash dump, jek.md is a personal note, and claude-session.mjs is a dead prototype superseded by packages/main/src/providers/claude-cli.ts (nothing imports it; the only mentions are a coincidental '.tmp-claude-session' string at claude-cli.ts:58 and a historical '参考 claude-session.mjs' note in docs/metadata/task.json). All six paths are git-tracked and would ship in the OSS release.

## Solution Tradeoffs
Delete the six dead paths and scrub any residual references (tsconfig path entries, doc mentions, package-lock fragments). Bundle them in one chore story because they are all confirmed-dead deletions verified by reference scan, sharing the same verification (build + e2e still pass, no residual references remain). The koala-lab subsystem (packages/lab) is kept and the experiments/ data-drop is deferred to a separate story, because that change is surgical (must preserve files consumed by verify-real-story-replay-benchmark and lab storage) rather than a clean deletion.

## Conversational Texture
The user is personally driving the open-source launch and wants the repo tidy; they confirmed 'keep lab, drop committed data' and 'one cleanup story now' when asked how to scope the work. The priority is shipping only the real Lattice product, not the toy projects it was tested against.
