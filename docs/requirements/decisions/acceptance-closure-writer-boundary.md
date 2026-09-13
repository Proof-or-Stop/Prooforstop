# Acceptance closure: writer boundary and missing checklist obligations

On 2026-09-13 the user explicitly requested Lab repair and RED/GREEN comparison of
B-3434 F-037 and the historical and recent acceptance omissions. This authorizes a
bounded local maintenance repair across the previously excluded StoryStore boundary.
The historical decision in validation-evidence-artifact-growth.md remains preserved,
including its reviewed digest and Finding IDs. Its decline describes that Story's
scope at that time; this new Lab supplies the previously absent writer protection.

StoryStore.writeTestEvidence now serializes once using the existing JSON format,
measures the exact UTF-8 string including the newline, and refuses more than 24 MiB
before creating a temporary file or replacing previous evidence. The 32 MiB reader
ceiling and 24 MiB writer ceiling derive from one dependency-free policy module.
Caller-side reduction remains best-effort. Its earlier size measurement is not an
identity guarantee for the published object. Other artifacts retain their own rules.

Once a checklist uses explicit verification, a non-withdrawn item with no intent
produces a required missing-coverage diagnostic. The diagnostic is not a stored
intent or evidence receipt. Existing all-empty legacy/express policy is unchanged.
This closes the partially bound checklist shape exemplified by B-cdf6 CHK-006;
it does not retrospectively invent its missing historical intent or receipt.

The committed regression runs the actual StoryStore in an isolated temporary root,
measures a 60 MiB post-measure mutation, exact-bound and one-byte-over inputs,
UTF-8 expansion, single serialization, atomic preservation, and partial checklist
coverage. The canonical process-fact verifier executes it, so it cannot disappear
solely because a new test was omitted from the full-suite inventory.

Lab evidence is local maintenance evidence, not Story DONE or release approval.
