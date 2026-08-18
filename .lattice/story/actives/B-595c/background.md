## Trigger Event

B-9ff1 (W2d, §1 of the trusted RED-evidence spec) closed its review on 2026-08-18 having empirically
proven five defects in the authorising document, and deferred every one of them with the phrase
"filed as follow-up". Its own concept lane then checked and filed B-9ff1:F-064 (high): no such
artifact existed. Grepping findings.json surfaced only B-7dfa (already DONE) and B-9ff1 itself, and
none of 348 stories in story_list referenced any deferred item. "Filed" was false as literally
written, four times over. This story is the artifact those four claims named, created so they become
true and so the next person has something discoverable to pick up.

## Key Insights

Each deferred item was proven by execution during B-9ff1's review, not hypothesised.

1. Matcher-value bounds are specified THREE times and TWO of the three are normative and disagree.
   spec:183-184 (§1.1.1 field definition) scopes the trimmed requirement and maxMatcherLen to
   `literal-line`. spec:499-504 (§1.6 R1-3, a normative REJECTION RULE, not a summary) bounds "ANY
   matcher value" with no kind restriction while enumerating class values in the same sentence.
   spec:293 (§1.2 policy table) restates it unqualified. The shipped code implements the §1.1.1
   reading; cross-vendor host B demonstrated a 513-byte and an untrimmed class value are both
   admitted. Which reading should win is an open decision, and R1-3's is arguably better: the
   implementation's objection (bounding a class NAME would make a legal registry unusable) is
   answered by not registering an over-long class name, while an unbounded class value is a real if
   small abuse surface. See B-9ff1:F-051, F-054.

2. The spec has no candidate-envelope schema. red_evidence_envelope_check validates a CANDIDATE whose
   purpose is to COMPUTE assertionDigest before a run is spent, so it must accept an envelope
   omitting policyDigest/assertionDigest — but §1 defines only the envelope embedded in stored
   records and grants no such exception. Host B's targeted search found no mention of
   red_evidence_envelope_check, or of a candidate envelope, anywhere in the 1607-line document. The
   implementation's most load-bearing scope decision is documented only in a source comment. See
   B-9ff1:F-052.

3. The §1.3 specificity metric inverts on short real-world failure constants. Measured: SIGSEGV
   (7 bytes, 15.65 bits), ENOMEM (6 bytes, 11.51), HTTP 404 (8, 20.00) and Error 500 (9, 21.77) are
   all REJECTED, while the vaguer phrase "test failed" (11, 34.05) is ADMITTED. Character-level
   Shannon entropy measures alphabet diversity, not semantic specificity, so signal names, errno
   codes and HTTP status lines score below longer generic English. ENOMEM sits below the NON-TUNABLE
   12-bit hard floor, so no policy can ever admit it. B-9ff1 pinned the current behaviour as a
   characterization fixture (F-060) so a formula change is caught mechanically, but did not change
   the metric. See B-9ff1:F-058.

4. EXIT_CLASS_EXACT requires `exit:<n>` in canonical no-leading-zero form, rejecting "exit:07". The
   spec authorises only `0 < n <= 255` and contains no canonical-form language in 1607 lines. The
   code is stricter than the text that authorises it — fail-closed, deliberate, tested, but
   undocumented. See B-9ff1:F-050.

## Solution Tradeoffs

The tempting shortcut is to edit the spec to match the shipped code in all four places. That is
wrong for item 1 at least, where the normative rejection rule may be the better design and the code
the thing that should move; deciding it inside the implementation's own story is exactly the move
B-9ff1 declined to make, correctly. So each item needs a stated decision first and a text edit
second, and item 1's decision may produce a code change in envelope.ts rather than a spec change.

Item 3 is the largest: replacing or supplementing character entropy with a measure that tracks
specificity affects every future RED record and every existing pinned matcher. An exemption registry
for known-short constants (signal names, errno, HTTP status) is the cheaper option and should be
compared against changing the metric, not assumed inferior.

The alternative — leave all four in B-9ff1's finding records only — was rejected because that is the
state F-064 was filed against: the gaps proven and then invisible to everyone who did not read one
closed story's resolution texts.

## Conversational Texture

This story exists because a reviewer refused to accept "filed as follow-up" without checking whether
anything had been filed. The deferrals themselves were individually defensible; what was not
defensible was claiming an ownership boundary had been exercised when no artifact had been created
on the other side of it. The same lane had already caught the identical error once on this story, in
a waiver, and it recurred five times in resolution prose written afterwards.
