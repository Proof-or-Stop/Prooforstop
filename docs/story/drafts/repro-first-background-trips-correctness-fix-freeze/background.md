## Trigger Event
On 2026-09-02 story B-83aa (created with story_create_from_repro from probe rp-mtk45bks-v1fiwl) ran scope_freeze_check in mode correctness_fix and recorded FAIL with the single hard issue future_capability_keyword: Excluded scope keyword Authority appears in story.background.
## Key Insights
The offending text is not authored by the operator; it is the fixed Solution Tradeoffs sentence that createStoryFromRepro writes into every repro-first story. The correctness_fix default keyword list is meant to catch future-capability creep in operator prose, so the two framework pieces contradict each other and every repro-first bug story is pushed to mode custom, weakening the default anti-expansion guard exactly for the stories it should protect.
## Solution Tradeoffs
Option one rewrites the generated background so it never contains a reserved keyword, which is minimal but fragile if the keyword list grows. Option two excludes framework-generated background sections from the keyword scan, which keeps operator prose guarded but needs a way to mark generated text. Option three keeps both and documents mode custom as the repro-first default, which is the workaround used today and is rejected as the permanent answer.
## Conversational Texture
The user asked for the four framework defects to be developed through the normal process until DONE; this gap surfaced as friction on the first INIT gate and was deferred as a draft per the defect-triage rule instead of widening B-83aa.
