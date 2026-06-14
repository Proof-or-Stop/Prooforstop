Comments should be extracted so that code and comments validate each other: whether the format matches, for example parameters; whether a function has a comment; whether a comment has a corresponding function; whether the comment is updated when the function changes — all of these should be validated. The same goes for flow. The program should be a graph, not a tree.

Every step of a flow should have a description, and when the code changes the flow must be force-updated too.

The entire code repository should be natively efficient for AI, and also explainable and traceable.

Humans access code through the interface that is AI, untangling the logic — much like the interface pattern. More precisely, code should be managed by an automated interface, and both humans and AI operate on the code through that interface. We can then require the AI to construct code in a particular structure, paired with strict automated code checks.

When making the AI access business logic through the interface is more efficient and more concise than it accessing the code with its own native tools, we have succeeded.

Ultimate goal: have the AI automatically turn the build into a loop, and make the loop more efficient.

---

## Status Analysis (2026-04-02) (Claude's analysis)

### Implemented

| Vision | Current status |
|------|------|
| Code managed by an automated interface | Story/fixture/comments are all managed through MCP tools; handwriting is prohibited |
| Humans and AI operate on code through the interface | task_annotate (comments), fixture_update (tests), story_create (plans) |
| Strict automated code checks | task_scan (comment validation), test_auto (white-box + e2e + drift), validateFixtureCase (format validation) |

### Partially Implemented

| Vision | Gap |
|------|------|
| Comments extracted, code and comments cross-validated | The drift check detects "the code changed but the comment did not follow," but does not do the reverse — "the comment exists but the function is gone" (e.g., the function was deleted but the comment remains) |
| Parameter/function validation | task_scan checks whether a function has a comment, but does not validate whether @input/@output matches the actual function signature |
| flow force-update | Changing a flow function does not force an update to the @flow comment |

### Not Implemented

| Vision | Notes |
|------|------|
| The program is a graph, not a tree | @flow is only a linear chain (step 1→2→3); it does not support branching/merging/parallelism. But flow may just be a temporary form, and need not necessarily become a DAG |
| AI accessing through the interface is more efficient than native | task_scan returns comment metadata, but the AI still has to read the source to understand the business logic. True efficiency would be: the AI asks "what does this function do," and the interface directly returns the responsibility, dependencies, call chain, and test coverage |
| build → loop automatic closed loop | Today it is a human-driven linear flow (create→dev→test→done); there is no ability to automatically detect "what should be done" and advance autonomously |

### Core Judgment

The focus of the current stage is **laying the foundation** — comment management, fixture management, and the validation loop. These are necessary prerequisites for the higher-level capabilities (semantic understanding, automatic closed loop). If the foundation is not solid, nothing can be built on top of it.
