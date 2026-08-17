## Trigger Event
On 2026-06-30, after B-a9e7 finished supersession cleanup, the user checked dev-memory and found old Koala/koala/.koala memory rows still visible. The user explicitly selected physical cleanup because legacy compatibility is unnecessary.

## Key Insights
Supersession solved ranking but not user friction: old brand text still appears in memory search and causes repeated confusion. The correct acceptance is zero old-brand hits in project and global dev-memory, not merely current guidance ranked first.

## Solution Tradeoffs
Physical cleanup removes old rows and old search tags, which sacrifices historical memory readability. That is acceptable here because the user is the only consumer and wants less noise more than archival compatibility.

## Conversational Texture
The user is frustrated that legacy wording keeps wasting time. The implementation should be direct, measurable, and avoid another clever compatibility layer unless a hard gate requires it.
