# B-a30e User-Value Transcript

## Expected

- `validate` accepts `storyId` as a real story alias, writes story test evidence, and reports conflicts instead of silently running diagnostic validate.
- TEST/DONE scope stale guidance no longer tells users to rerun reviewer "before REVIEW-to-TEST"; REVIEW guidance still does.
- Owner-gated command help exposes `--takeover` and `--forceTakeover`; read-only command help does not.
- Scope warnings say advisory/not blocking and name recovery options.

## Actual

Repo-local CLI after `npm --prefix packages/main run build`:

```text
$ KOALA_SESSION_ID=codex-supervisor-B-a30e node packages/main/dist/cli.js validate '{"storyId":"B-a30e","json":true}'
status=pass allPass=true
summary=Project validation commands passed; validate.ts/js/mts not found and no configured validate.command(s); used advisory fallback command discovery
verificationCoverage=15/15 covered, 0 required missing
```

```text
$ node packages/main/dist/cli.js validate --help | rg -- '--storyId|Owner lease meta options|--takeover|--forceTakeover|diagnostic validate'
--storyId   string           B-a30e: --story alias; conflicting values fail
Owner lease meta options (applies when --story is supplied; diagnostic validate without --story is always read-only)
--takeover
--forceTakeover

$ node packages/main/dist/cli.js story_advance --help | rg -- 'Owner lease meta options|--takeover|--forceTakeover'
Owner lease meta options
--takeover
--forceTakeover

$ node packages/main/dist/cli.js checklist_update --help | rg -- 'Owner lease meta options|--takeover|--forceTakeover'
Owner lease meta options
--takeover
--forceTakeover

$ node packages/main/dist/cli.js status --help | rg -- 'Owner lease meta options|--takeover|--forceTakeover'
(no output)
```

```text
$ node --input-type=module <scope-summary-smoke>
REVIEW stale next action: Reviewer scope binding is stale (contract/code changed) - re-run the reviewer via review_run_start before REVIEW-to-TEST.
TEST stale next action: Reviewer scope binding is stale (post-review advisory) - if changes were made after REVIEW, roll back to DEV and re-review, or verify via delivery reviewer.
TEST warning next action: Scope warnings present (advisory, not blocking) - acknowledge in DEV/REVIEW via scope_contract_acknowledge if needed, roll back to DEV when in TEST, or verify via delivery reviewer.
```

Verification commands run on integrated HEAD:

```text
npm --prefix packages/main run build                                               pass
npm --prefix packages/main run test:validation-protocol                            pass
npm --prefix packages/main run test:story-owner-lease-smoke                        pass
npm --prefix packages/main run test:command-ownership-contract                     pass
npm --prefix packages/main run test:semantic-scope-guard-smoke                     pass
npm --prefix packages/main run test:scope-contract-smoke                           pass
npm --prefix packages/main run test:flow-stability-smoke                           pass
node scripts/verify-process-fact-contract.mjs                                      pass
```

## Diff

The repo-local CLI behavior matches the expected product behavior. The currently installed global `lattice` symlink resolves to `/Users/jek/Documents/Work/Orchestrate/packages/main/dist/cli.js` in the main worktree, so it will show the new help after the story is merged to main and `npm --prefix packages/main run build` is run in the main worktree.
