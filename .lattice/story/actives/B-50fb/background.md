## Trigger Event
On 2026-06-12 the user noticed the published package identity shows @koala-agent/core 0.3.5 and explicitly asked where @koala-agent is configured because they do not want the product/package branding to be called Koala anymore.

## Key Insights
The canonical package name is in packages/main/package.json, with dependent package names in packages/utils, packages/lab, and package-lock files. Code also hard-codes @koala-agent/core for runtime diagnostics, worktree relink, bootstrap wrappers, prompt registry source, and verification scripts.

## Solution Tradeoffs
A one-field package.json edit would change the displayed name but leave bootstrap, runtime checks, generated wrappers, and docs pointing at the old scope. The safer path is to make @lattice-agent/* canonical while keeping @koala-agent/* only as a legacy fallback where existing projects still need compatibility.

## Conversational Texture
The user wants the work done through the Lattice lifecycle rather than an ad hoc patch. Keep the change focused on package identity and canonical references, avoid broad product copy churn unless it is directly tied to the public package name, and verify before advancing lifecycle phases.
