## Trigger Event

While working B-3f3d on 2026-08-17, the story could not obtain a topology-critic receipt. Two blockers were found. The first (BUG-TOPOLOGY-CRITIC-RECEIPT-UNREACHABLE) was fixed in commit 9f9f53a514. The second is BUG-CRITIC-DISPATCH-PROVENANCE-UNSATISFIABLE: deriveRoleProvenance requires a dispatch event whose sessionId equals the signer's own session, but dispatch is not in the critic's allowedCommandIds, so a correctly sandboxed critic can never satisfy it.

Attempting to solve that surfaced a worse problem, recorded as BUG-INDEPENDENCE-MATRIX-IS-TEXTUAL-ONLY. The story owner set LATTICE_SESSION_ID to a chosen value, recorded a dispatch event under it, and handed the same id to a critic subagent. Every mechanical check passed. An independent topology critic refused to adopt the session and explained why, which is the only reason the bypass was not used.

## Key Insights

independenceMatrix (topology-critic-receipt.ts:181-188) establishes independence with four textual !== comparisons between actor and implementation provenance. Neither deriveRoleProvenance nor deriveImplementationProvenance checks who originated an identity; both read sessionId off the most recent matching ProcessEvent on disk. When one party controls both sides of the comparison, the proxy reports independence that does not exist.

The mechanism to fix this already exists and does not need inventing. resolveSessionIdentity classifies every session by sessionSource: host-adapter sessions are derived by deriveAdapterOwnerSessionId from provider plus task plus agent identity, so an implementer cannot mint one. explicit-env is whatever was placed in LATTICE_SESSION_ID. derived-ppid is a hash of the process tree. Only the first is evidence of an independent actor.

## Solution Tradeoffs

Three options were considered for the dispatch-provenance blocker. Opening the dispatch command to the critic role is the smallest change but lets the critic mint its own credential, which weakens the property being protected. Re-keying the binding to something other than sessionId avoids the issue but requires redesigning what counts as a valid dispatch. Requiring a host-adapter session was chosen: it preserves the guarantee that the implementer cannot supply the critic's identity, and it consumes a distinction the codebase already computes.

The cost is real and is why this is a separate story rather than an inline fix. A prototype guard was written and verified to work, correctly refusing explicit-env, but 208 references across 30 files under packages/main/src/tasks build sessions via LATTICE_SESSION_ID and would all be refused. That prototype was reverted rather than carried further, because rewriting the identity setup of the whole test suite on a security boundary is not something to do incrementally inside another story's REVIEW phase.

## Conversational Texture

The user chose option 1 after being shown the three candidates. The decision was explicitly reserved for the user because all three change who is permitted to sign a critic receipt, which is the core property the proof system defends.

Worth preserving for whoever picks this up: the bypass was caught by a reviewer refusing, not by any mechanical check. The refusal is currently the only thing standing between an implementer and a self-signed critic receipt. That is precisely what this story converts into a mechanism.
