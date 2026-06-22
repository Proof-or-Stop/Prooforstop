# B-c76c Plan

## CHK-001 Compare proofbound and Orchestrate tracked baseline

Run tracked-only comparisons from proofbound against refs/remotes/orchestrate/main. Capture the diff summary and explicitly classify excluded root docs, untracked experiments, local evidence, docs/story, and tests/fixtures as not part of the import.

Acceptance evidence will include git diff --stat output and a staged/untracked exclusion check.

## CHK-002 Import canonical tracked code and config changes without legacy evidence

Apply the selected tracked source/config/docs paths from refs/remotes/orchestrate/main into the B-c76c worktree. Do not import AGENTS.md, CLAUDE.md, .lattice/local-evidence, experiments, docs/story, tests/fixtures, or migrated B-3523/B-fbb6 business work. After import, inspect git status and targeted diffs before committing.

Acceptance evidence will include a status/path audit and a diff check against the legacy ref for imported paths.

## CHK-003 Regenerate version artifacts consistently

Regenerate package-lock metadata in proofbound after the source/config import. Verify package.json, packages/main/package.json, and package-lock root metadata all report 0.3.63. Do not blindly copy Orchestrate package-lock root metadata because it currently reports 0.3.49.

Acceptance evidence will include a Node metadata check that fails on 0.3.60 or 0.3.49 residue.

## CHK-004 Verify proofbound reports the imported CLI baseline

Build packages/main and packages/utils, then run node bin/lattice.js --version from proofbound to prove the local checkout reports Lattice CLI 0.3.63. Review git status to make sure only in-scope files and story metadata are present before advancing review/test.

Acceptance evidence will include build commands, local version output, and final path audit.
