# B-1637 Real-machine verification — transcript + diff

Story: Route lattice doctor git probes through the resolved gitRoot.

## Expected (PLAN / checklist userSees)

Running `lattice doctor` from a wrapper-root project (metadataRoot != gitRoot,
e.g. ClawCreek) prints the normal report with NO leading
`fatal: not a git repository` lines.

## Method

Built a wrapper-root fixture identical in shape to the ClawCreek incident:

- `wrapper/`            — metadataRoot, NOT a git repo
- `wrapper/repo/`       — the real git repo (configured `gitRoot: "repo"`)
- `wrapper/lattice.config.json` — `{ "storyDir": "repo/.lattice/story/actives", "gitRoot": "repo" }`
- one active story `B-wrap` index.json inside the gitRoot

Then ran the freshly-built CLI (`node packages/main/dist/cli.js doctor`) with
cwd = the non-git wrapper metadataRoot. The global `lattice` symlink is a stale
dist, so verification used the freshly-built runtime.

## Actual transcript

```
### sanity: metadataRoot is NOT a git repo (raw git there leaks fatal)
fatal: not a git repository (or any of the parent directories): .git

### REAL CLI from the wrapper metadataRoot:  node packages/main/dist/cli.js doctor
exit=0
grep 'fatal: not a git repository' across stdout+stderr:
  err.txt:0
  out.txt:0
stdout head:
  | Runtime footprint:
  | Runtime mode: compatibility-launcher
  | Runtime source: external-development-engine
stderr (full):
  | [0.0s] running doctor...
  | [0.8s] doctor done
```

## Diff (expected vs actual)

- Expected: no `fatal: not a git repository` line in the doctor report. **MATCH** —
  grep count is 0 across both stdout and stderr; exit 0; report still produced.
- The sanity line confirms the fixture is genuinely a wrapper-root: a raw
  `git rev-parse` in the metadataRoot DOES print `fatal: not a git repository`,
  yet `lattice doctor` run from that same dir prints none — proving the probes
  now run in the resolved gitRoot subdir and the discovery calls pipe stderr.
- The only stderr is the harmless `running doctor... / doctor done` progress.

## Root-cause confirmation (isolate/confirm, Debugging Contract)

Direct contrast of the two discovery-call variants on the same wrapper fixture:

```
OLD cwd=root (metadataRoot), stderr inherited → leaked:
  "fatal: not a git repository (or any of the parent directories): .git"
NEW stderr piped (stdio: ['pipe','pipe','pipe']) → leaked: ""  (empty)
```

So the leak required BOTH the wrong cwd (non-git wrapper) AND inherited stderr;
the fix routes cwd through the resolved gitRoot (`resolveDoctorGitCwd`) and pipes
stderr on the two `execSync` discovery calls.

## Automated regression

`packages/main/src/tasks/doctor-gitroot-probe-smoke.ts`
(`test:doctor-gitroot-probe` in both package.json files):

```
doctor-gitroot-probe smoke (B-1637)
✓ resolver: wrapper-root → configured gitRoot subdir (≠ non-git metadataRoot), is a git repo
✓ resolver: plain-repo → projectRoot (byte-identical to old cwd=root fallback)
✓ resolver: null gitRootAbs → ?? root falls back to root verbatim
✓ e2e: wrapper-root doctor() → NO "fatal: not a git repository" (report still produced)
✓ e2e: plain-repo doctor() → unchanged (no fatal output, report produced)

✓ doctor-gitroot-probe smoke passed (resolver + wrapper-root e2e + plain-repo e2e)
```

`lattice validate` PASS; `lattice validate --lint` PASS (tsc 3 tsconfigs).
