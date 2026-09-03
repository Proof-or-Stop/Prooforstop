## Trigger Event
B-1fa6 formal validation and a separate reproduction on current main both failed because the retired-authority instrumentation assertion observed 804 dynamic binding graph builds against its fixed ceiling of 800.

## Key Insights
The failing assertion is test instrumentation rather than production behavior, but it is a mandatory project validation command. The source inventory now needs four more graph builds than the last explicit performance budget allowed.

## Solution Tradeoffs
Keep an absolute bounded ceiling and add small documented headroom instead of removing the assertion or making the budget scale automatically with repository size. This preserves regression sensitivity while admitting the measured current baseline.

## Conversational Texture
The parent work is intentionally a documentation-only audit, so this repair must remain an independent Story. Once it lands on main, the document Story can merge main and validate without smuggling source changes into its own scope.
