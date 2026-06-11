# B-70f5 Execution Plan

Scope: fix only the two documentation inconsistencies confirmed by the Claude CLI and Codex CLI host audits. Do not move root Markdown files, do not delete KOALA.md in this story, and do not rewrite unrelated documentation.

## CHK-001

Action: update docs/requirements/NAV.md so the declared decision-document count matches the actual decisions directory and NAV decision links.

Boundaries: change only the stale count line. Do not regenerate, reorder, or reword the NAV link list unless mechanical verification proves a link mismatch.

Verification: run a docs check comparing the declared count, the number of decisions/*.md files, and the number of NAV decision links. Review git diff to confirm no unrelated NAV churn.

## CHK-002

Action: update the Lattice-lifecycle-memory-Evolving.md row in docs/requirements/decisions/root-document-migration-guide.md so its target home matches the split destination already stated in root-markdown-migration-execution-solution.md.

Boundaries: add lifecycle-artifact-scope.md as the second destination for that row only. Do not add host-specific claims or change the broader root cleanup policy.

Verification: run a docs check that the row contains both dev-memory.md and lifecycle-artifact-scope.md, then review git diff to confirm no unrelated migration-guide churn.
