## Trigger Event

On 2026-09-04 the quality lane on B-77e6 filed B-77e6:F-007 during REVIEW round 1. That story migrated twenty-six handlers under packages/main/src/handlers onto the shared story workspace resolver, including handlers/phase-gates.ts, whose proofStoryDiagnosticInput now resolves the workspace before reading the story and checklist. The reviewer found that packages/main/src/core/machine.ts, at roughly lines 156 to 186, keeps a private, unmigrated proofStoryDiagnosticInput and proofStoryDevGateFailure that read directly off context.store and context.projectRoot and never touch the resolver. Same fact, two resolution strategies. B-77e6's scope contract covers handlers only, so this was routed rather than repaired there.

## Key Insights

The defect is not that machine.ts is wrong on its own; it is that the repository now answers the question "which tree do I read this story's ProofStory diagnostic input from" two different ways depending on which copy of the builder runs. handlers/phase-gates.ts answers "the story's workspace, terminal-phase guarded"; core/machine.ts answers "whatever store and root the machine context was constructed with". Those agree only when the machine context happens to be built on the same tree, which is exactly the assumption B-41c8 and B-77e6 exist to stop relying on.

It is invisible to the audit fixture that measures the migration, because packages/main/src/tasks/single-owner-extraction-smoke.ts scans packages/main/src/handlers/*.ts for resolveGitCwd callers and classifies their reads. core/machine.ts is neither in that directory nor a resolveGitCwd caller, so a duplicate builder there registers as nothing. That is the same shape as the unreachable-suite draft: an instrument whose scope is a directory choice reports zero for anything outside the directory.

The machine copy sits on the REVIEW/TEST to DEV re-entry guard. The process fact contract in scripts/verify-process-fact-contract.mjs pins machine.ts to call proofStoryDevGateFailure(context.store, context.projectRoot, context.storyId) by literal text, so any change here must move the contract assertion with it, in the same way B-77e6 had to for candidate-spec-routing.ts.

## Solution Tradeoffs

The direct fix is to make machine.ts's guard delegate to the handlers copy, or to hoist one builder into core and have both call it, so there is one owner. The cost is a dependency direction question: core/machine.ts is meant to be pure configuration and may not import from handlers, so the hoisted builder likely belongs in core beside the resolver, with phase-gates.ts becoming a caller rather than an owner.

The alternative is to leave two copies and add the machine copy to the audit fixture's scope by widening the scan to core, so at least the duplicate is visible. That makes the instrument honest without fixing the drift, and it would flag machine.ts permanently unless the fixture also learns why a pure machine module cannot resolve a workspace.

Doing nothing is defensible only if the machine context is proven to always be constructed on the story's workspace, in which case the two copies cannot disagree; that proof does not exist today and the reviewer looked for it.

## Conversational Texture

Filed by the quality lane while auditing worker-to-worker drift across six sequential implementers on B-77e6, asked specifically whether the repository had ended up with several names for one idea. This is the one instance it found outside the story's scope boundary. Routed here with the reviewer's file and line evidence rather than silently absorbed, because widening a handler-migration story into the state machine to make one more number green is the scope expansion its owner was told not to do.
