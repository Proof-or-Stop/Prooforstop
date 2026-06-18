# Plan — B-5d48: Experience Layer ③.2 signatureTag auto-candidate + provenance

Make finding_add populate a signatureTag (auto fallback) when the reviewer omits one, and record provenance (auto vs confirmed). Both fields stay audit-only and OUT of the finding _hash / signFinding / every gate. finding.ts is gate-critical — the _hash-invariance is the single most important check.

## CHK-001 — Pure candidate-derivation leaf + source type

- New `packages/main/src/core/signature-candidate.ts`, imports only `node:`/types:
  - `export function deriveSignatureCandidate(category?: string, files?: string[], desc?: string): string` — deterministic: `category` (default 'unknown') + coarse fileKind (first file's extension, else first path segment, else 'unknown') + a normalized desc key (lowercase, strip punctuation + stopwords, first ~3 tokens with len>=4), joined by `|`. Tolerates missing/empty inputs (never throws, never empty string — falls back to `category|fileKind|`).
- In `packages/main/src/core/experience-layer-types.ts` add `export type SignatureTagSource = 'auto' | 'confirmed';` documented as audit-only provenance.
- No I/O in the leaf.

## CHK-002 — Wire into finding_add (audit-only, _hash-invariant)

- In `packages/main/src/handlers/finding.ts` finding_add:
  - Compute `const suppliedTag = (args.signatureTag ?? '').trim();`
  - If `suppliedTag` non-empty: `signatureTag = suppliedTag; signatureTagSource = 'confirmed';` (existing behavior, byte-identical, just record source).
  - Else: `signatureTag = deriveSignatureCandidate(category, files, desc); signatureTagSource = 'auto';` (optionally fold through `resolveTag(ctx.root, signatureTag)` for alias canonicalization).
  - Persist `signatureTag` and `signatureTagSource` on the stored finding object ONLY (the same place signatureTag is persisted today, ~line 320), conditionally attached.
  - CRITICAL: both fields are EXCLUDED from `signFinding` / the finding `_hash` (mirror the existing signatureTag exclusion) and from every gate and the finding signature. Do NOT change `signFinding`'s hashed input.
  - The existing `signatureTagHint` / `hasActiveOrProposedTag` behavior for supplied tags stays.

## CHK-003 — Smoke + npm script + verifier (incl. _hash invariance)

- New `packages/main/src/tasks/experience-layer-signature-capture-smoke.ts`:
  - `deriveSignatureCandidate` is deterministic and sane on representative inputs (with files, empty files, missing desc, non-string files); never empty.
  - finding_add with NO tag → persisted finding has `signatureTagSource: 'auto'` + a non-empty `signatureTag`; WITH a tag → `'confirmed'` + the supplied tag unchanged.
  - **CRITICAL _hash invariance:** the finding `_hash` / signature is byte-identical whether or not signatureTag/signatureTagSource are present (construct a finding, hash it via signFinding with and without the fields, assert equal) — no gate perturbation.
  - Print `signature-capture smoke passed`.
- `packages/main/package.json`: add `"test:experience-layer-signature-capture": "node dist/tasks/experience-layer-signature-capture-smoke.js"`.
- Committed `.lattice/story/actives/B-5d48/evidence/verify-b-5d48.mjs` (model on prior verifiers): build clean + this smoke + no-regression smokes (finding-signals/playbook/recall/revalidation/learning-scan) + full `npm test` green (incl. process-fact-contract) + static checks: signature-candidate.ts imports only node:/types; finding.ts does NOT add signatureTag/signatureTagSource to the signFinding hashed input (grep the signFinding region). Maps every verificationIntent; prints `TOTAL N | PASS N | FAIL 0`.
