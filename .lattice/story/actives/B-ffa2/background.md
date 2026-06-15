## Trigger Event
On 2026-06-15, after the Koala binary alias removal, the user noticed remaining role names such as koala-implementer inside Lattice CLI and asked to run a normal story that writes an execution document and cleans every active Koala naming surface.

## Key Insights
The remaining Koala strings are mostly not executable binary aliases; they are subagent and reviewer role identifiers spread through prompt templates, mirrored host assets, story dispatch, command help, review attribution, and active documentation. Renaming them is therefore a contract migration, not just text cleanup.

## Solution Tradeoffs
The safest path is to define a canonical lattice-* role map first, then update templates, runtime schemas, generated assets, tests, and active docs together. Historical archived material may need explicit legacy labeling, while active CLI output and templates should stop teaching Koala names.

## Conversational Texture
The user is intentionally removing legacy compatibility because this is still a private early system. They want a clean Lattice surface, but they also want the change to respect the normal story process and leave an execution document for future hosts.
