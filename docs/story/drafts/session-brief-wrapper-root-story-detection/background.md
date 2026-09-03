## Trigger Event
On 2026-09-03 the B-83aa CHK-003 implementer, fixing Codex cross-host finding B-83aa-xhr-r2 (session brief DONE pre-check probed the non-git metadata root), found that a wrapper-root fixture never reaches the pre-check: detectActiveStoryFromGit exits 128 on the metadata root and session_brief prints No healthy active story / 1 zombie stories before and after the fix.
## Key Insights
The pre-check cwd fix is right by the B-6666 pattern but has no brief-level observable until story detection itself resolves the configured gitRoot or signed workspace; the same ctx.root assumption sits in readGitStatus and the worktree and stale-evidence probes of that branch, so the change is a coordinated session_brief behaviour change rather than a one-line fix.
## Solution Tradeoffs
Option one resolves the signed workspace once at the top of session_brief and threads it into detection and every git probe, matching done-oracle and the DONE gate; option two keeps detection as is and documents that wrapper-root briefs show a zombie story, which hides real state; option three only patches detection and leaves the other probes on ctx.root, which reintroduces split-brain reads. Option one is preferred.
## Conversational Texture
The user asked for the gate-layer defects to be driven to DONE; this is a scope boundary of B-83aa (brief detection is not a gate consumer) and is deferred as a draft per the defect-triage rule with the exact fixture and probe output recorded.
