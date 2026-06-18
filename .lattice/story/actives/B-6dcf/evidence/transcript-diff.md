# B-6dcf User-Value Transcript Diff

## Expected

- `lattice check --json` exposes stable root diagnostics at the result root:
  `metadataRoot`, `assetRoot`, `gitRoot`, `pathsRelativeTo`, and
  `assetRootGitRootSplit`.
- `lattice check` text output explains that managed asset `relPath`,
  `applied`, and `manifestPath` values are relative to `assetRoot`.
- When `gitRoot` is the same as `assetRoot`, the text says so without implying
  managed assets are rooted somewhere else.
- Existing drift detection remains intact.

## Actual Transcript

Command:

```bash
node packages/main/dist/cli.js check --json
```

Observed root diagnostics:

```json
{
  "metadataRoot": "/Users/jek/Documents/Work/Orchestrate/.worktrees/B-6dcf",
  "assetRoot": "/Users/jek/Documents/Work/Orchestrate/.worktrees/B-6dcf",
  "gitRoot": "/Users/jek/Documents/Work/Orchestrate/.worktrees/B-6dcf",
  "pathsRelativeTo": "assetRoot",
  "assetRootGitRootSplit": false,
  "manifestPath": ".lattice/managed-assets.json",
  "ok": false
}
```

Command:

```bash
node packages/main/dist/cli.js check 2>&1 | sed -n '1,18p'
```

Observed terminal output:

```text
[0.0s] running check...
[0.2s] check failed: Runtime footprint:
Runtime mode: compatibility-launcher
Runtime source: repo-local-dist
Project-local JavaScript runtime required: no
Authority: local-runtime-diagnostic-only
Next action: review unsafe managed assets manually

Lattice managed asset check: DRIFT (profile=all, assetMode=global-thin)
Summary: OK=8, MISSING=0, CASE_MISMATCH=0, STALE_SAFE=3, STALE_LOCAL_EDIT=1, INCOMPATIBLE=0
Paths: managed asset relPath/applied/manifestPath values are relative to assetRoot.
  metadataRoot: /Users/jek/Documents/Work/Orchestrate/.worktrees/B-6dcf
  assetRoot: /Users/jek/Documents/Work/Orchestrate/.worktrees/B-6dcf
  gitRoot: /Users/jek/Documents/Work/Orchestrate/.worktrees/B-6dcf (same as assetRoot)

Drift:
  - STALE_SAFE .lattice/Lattice.md: Lattice managed section differs from template
    action: replace managed section only
```

## Diff Notes

- Expected root diagnostics are present in JSON exactly where callers can parse
  them without scraping prose.
- Expected path-base guidance appears in text output before the drift list, so a
  user can tell which root `relPath` and `check --apply` refer to before acting.
- Actual output still reports the pre-existing managed asset drift; this is
  correct because this story only clarifies path roots and does not apply or
  silence drift.

## Verdict

Accepted. The user-facing ambiguity is resolved for the normal same-root case,
and wrapper-root split behavior is covered by `npm run test:managed-assets-wrapper-root`.
