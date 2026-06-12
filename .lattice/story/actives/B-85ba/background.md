# Background: Scope Anti-Expansion Gate

## Trigger Event
On 2026-06-12, a real Lattice planning incident showed that INIT reviewers and agents can accidentally pull future capabilities into a narrow correctness story before INIT_CHECK creates a worktree. The concrete case discussed by the user is that without a scope anti-expansion gate, Loop and multi-agent execution amplify the wrong boundary instead of closing inside the intended one.

## Key Insights
The existing init-check signature protects background, title, description, and checklist after the reviewer artifact is written, and the later scope contract protects changed files after planning. The missing layer is earlier: a user-confirmed semantic boundary must exist before INIT reviewers can influence scope. This boundary needs mechanical checks, not prompt-only discipline.

## Solution Tradeoffs
The conservative option is to add a narrow INIT-only scope boundary artifact, execution boundary artifact, scope freeze check artifact, and scope extension proposal path before INIT_CHECK. This costs extra metadata and tests, but it keeps worktree creation lightweight and prevents wasted tokens. Reusing only the later scope contract would be cheaper, but it would detect file drift too late.

Additional boundary decision after INIT review: canonical scope comes only from scope-boundary.json created from story_create inputs or explicit INIT-only scope_boundary_set repair. Missing boundary is a hard INIT_CHECK blocker, not an invitation to infer whole-project scope. Default excluded future keywords apply only to correctness_fix mode; feature/refactor stories must use user-confirmed excludedScope. False positives require scope_extension_proposal plus explicit accept/reject, never direct checklist mutation.

## Conversational Texture
The user explicitly framed this as an auditor-led, multi-host, multi-agent implementation and emphasized that Lattice should keep AI inside the correct boundary rather than make it freer to loop. The implementation should therefore treat auditability, typed process facts, and early blocking as first-class product behavior, not merely as documentation or reviewer advice.
