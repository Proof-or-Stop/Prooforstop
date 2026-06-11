# B-0f04 Plan

## Guardrails

- Claude Code performs the audit execution and writes the primary audit report.
- Codex acts as project manager and verifier: it checks evidence, reruns selected commands, and records manual verification evidence.
- No production code changes are allowed in /Users/jek/Documents/Work/Orchestrate, /Users/jek/Documents/Work/Koala/cord-team, or /Users/jek/Documents/Work/Koala/Koala. Only B-0f04 story metadata/evidence artifacts may be written.
- Any implementation gap discovered here becomes a separate follow-up story in the owning repository.

## CHK-001

Goal: record Koala CLI post-merge health without assuming a green result.

DoneWhen:
- Run and record raw output/status for: `session_brief`, `convergence_check`, task annotation validator, `npm test` after any required build step, and `git status --short`.
- Record whether existing active INIT backlog is unrelated to this audit.
- If a command fails, classify it as product failure, environment/setup failure, or expected in-flight state with concrete evidence.
- Add the CHK-001 section to `.koala/story/actives/B-0f04/evidence/cross-end-contract-audit.md`.

## CHK-002

Goal: map cross-end authority/evidence contract surfaces across the three repositories with file references.

Repositories to confirm first:
- Koala CLI: `/Users/jek/Documents/Work/Orchestrate`.
- Cord Team Python authority: `/Users/jek/Documents/Work/Koala/cord-team`.
- Koala Mac/Swift: `/Users/jek/Documents/Work/Koala/Koala`.

Per-surface DoneWhen matrix rows:
- EvidenceEnvelope / evidence schema fields.
- Receipt issuance, receipt lookup, and server receipt authority.
- trustLevel / L2-L4 policy and strict/anti-hallucination presets.
- producerRunId / verifierRunId binding.
- provider / model / vendor heterogeneity.
- verificationContextPack id/digest/refs/inspected refs.
- Gate consumption: local evidence vs server receipt, DONE/REVIEW/TEST paths.
- authority mode / preset enforcement and production enforce controls.
- Client/runner submission responsibilities and gaps.

For each row, mark status as aligned, partial, missing, or follow-up-needed. Every status must cite concrete files or command output. Do not infer alignment from naming similarity.

## CHK-003

Goal: produce an actionable gap report and PM recommendation list.

DoneWhen:
- The report separates already-solved items, blockers, non-blocking advisories, and follow-up recommendations.
- Each follow-up recommendation names the owning repository: Koala CLI, Cord Team Python authority, or Koala Mac/Swift.
- Compare recommended follow-ups against known active backlog, including B-4622 and B-da5b, to avoid duplicate work.
- Codex independently verifies high-risk claims that could trigger development work and records the verification in `.koala/story/actives/B-0f04/evidence/codex-verification.md` plus checklist evidence.
- Final report is concise enough for the user to decide the next development story without rereading the whole thread.
