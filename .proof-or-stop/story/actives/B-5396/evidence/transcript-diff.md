# B-5396 real-machine acceptance transcript + diff

## Expected (PLAN outcome)
Opening AGENTS.md or CLAUDE.md (or `grep -n "Host DONE convergence" AGENTS.md CLAUDE.md`) shows a new
"Host DONE convergence / drift handling" section with the 7 rules + 2 VERBATIM paragraphs + 4
decision-doc references; both copies identical; `lattice` behavior byte-identical (no code change).

## Actual (run from the story worktree)

```
$ grep -c 'Host DONE convergence' CLAUDE.md AGENTS.md
CLAUDE.md:1
AGENTS.md:1

$ grep -cF 'lattice done_prepare' CLAUDE.md
2

$ diff <(sed -n '/Host DONE convergence/,/manually bypass cleanTree/p' CLAUDE.md) \
       <(sed -n '/Host DONE convergence/,/manually bypass cleanTree/p' AGENTS.md)
(no output — byte-identical)

$ lattice done_prepare --storyId=B-5396 --mergeMain --refreshStale --validate --dryRun
DONE prepare: BLOCKED / blockedAt: preflight (story in REVIEW)   # flag form PARSES (proves the runbook command works; later TEST-phase run proceeds)

$ lattice validate (via REVIEW->TEST preflight)
validate PASS, writing test-evidence.json
```

## Diff (expected vs actual)
No difference. Both files carry the identical runbook section; the cited decision docs exist; the
`done_prepare` flag form in the runbook is verified to parse (`--help` documents it). validate PASS.

## Note on F-001 (host-2-style adversarial catch, resolved)
The quality reviewer initially filed F-001 (high) claiming the `--mergeMain/--refreshStale/--validate`
flag form would error (only JSON works). Empirical disproof (`done_prepare ... --dryRun` parses all
flags; `--help` documents them) was brought back to the reviewer, who re-ran it, agreed its stated
impact was wrong, and resolved F-001. The runbook keeps the working, --help-documented flag form.

## Limitations
Docs-only runbook; it is a projection that cites the authoritative decision docs rather than
re-deriving them. Metadata-only dirty-state specifics are deferred to B-9dfb (pointer only).
