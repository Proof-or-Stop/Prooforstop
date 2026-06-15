## Trigger Event
2026-06-15 after B-d959 completed, the user clarified that document audit should also follow ordinary development automatic 3x2 or degraded 3x1 rules instead of always requiring a special decision-doc 3x2 gate.

## Key Insights
The current execution plan still preserves an always-on decision-doc 3x2 rule. That conflicts with the user's latest policy direction: documentation audit should not be a permanent special case and should share the same automatic escalation trigger as normal development.

## Solution Tradeoffs
Removing always-on decision-doc 3x2 lowers default friction for documentation changes, but it must keep review safety by using the same first-round countable problem threshold and the same explicit degraded-single-host semantics. The plan must also call out that current code may still enforce legacy decision-doc 3x2 until the implementation story updates the gate.

## Conversational Texture
The user is steering toward a practical and consistent rule. The right response is to align the plan with one unified lifecycle policy while being honest that runtime implementation still needs a follow-up code change.
