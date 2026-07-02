# Tier-C Cross-Host Quorum — Threat Model & Key-Management Decision (M0)

Status: draft for human review (2026-07-02)
Scope: define, before any run, what makes a CLI-only 2-host signed quorum SOUND, and the honest
ceiling of the independence claim. This is M0 of `tier-c-crosshost-quorum-execution-plan.md`.
Non-goal: no implementation here; this fixes the rules M1/M2 must enforce and the wording M5 may use.

## 1. What a quorum asserts (and does not)

A valid Tier-C quorum asserts: **two verdicts, each Ed25519-signed by a distinct pinned host key,
each bound to the same materialHash, were produced by two different vendor hosts reviewing the same
code, and both pass — and any third party can verify this offline.**

It does NOT assert: that the two hosts are on different machines, different operators, or a
mutually-hostile trust boundary. See the independence ceiling (§3).

## 2. Trust anchor: the pinned key manifest

- Trust is anchored in a pinned `[hostId → publicKeyBase64]` manifest distributed **out-of-band**
  (committed to the repo / shipped with the verifier), never taken from the verdict body.
- A verdict's signer key is verified against the PINNED key for its claimed hostId, not the
  self-reported key in the bundle (mirrors the existing `receipt-bundle.ts` rule: verify against
  `context.publicKey`, never the bundle's own).
- Manifest is versioned; a verdict records the manifest version it was signed under.

## 3. Independence definition and its honest ceiling

- **Claimed independence = cross-vendor:** host A = Claude (Anthropic model family), host B = Codex
  (OpenAI model family) — distinct vendors, distinct model families, distinct signing keys held
  separately. This is the property the paper may claim.
- **Ceiling (must be stated, not hidden):** the two hosts are orchestrated by the SAME operator on
  (possibly) the same machine. So the guarantee is **cross-vendor independence of review**, NOT a
  sysadmin-level mutually-distrusting distributed-trust model. The paper's Threats section keeps:
  "cross-vendor independent, same-operator orchestrated; not a Byzantine multi-party trust claim."
- Consequence for wording (M5): allowed = "an independent second-vendor host produced a
  cryptographically verifiable verdict"; forbidden = "mutually-distrusting parties" / "no operator
  trust required."

## 4. Threats and fail-closed defenses (the rules M1/M2 enforce)

| Threat | Attack | Defense (fail-closed) |
|---|---|---|
| Forged verdict | unsigned, or signed by a non-pinned key | reject: signature must verify against the pinned key for that hostId |
| Same-key masquerade | one CLI/key emits both "independent" verdicts | reject: quorum requires two DISTINCT pinned keys (this is the core M1 fix — today independence is label-only) |
| Stale materialHash | a host reviewed old code, submits over a drifted tree | reject: materialHash freshness check + the M2 handshake (both hosts pinned to the same tree sha before either submits) |
| Replay | reuse a previously-valid signed verdict | reject: verdict binds materialHash + round + timestamp; a verdict is admissible only for its bound (material, round) |
| Partial/omission | drop one verdict, or `push(null)` after signing | reject: strict bundle-shape check (the F-005 anti-null-elision defense already in `receipt-bundle.ts`) |
| Key compromise | a pinned private key leaks | rotate: manifest version bump + revocation list; verdicts under a revoked key are inadmissible from the revocation timestamp |

Global rule: on ANY of {signature invalid, key not pinned, two same keys, stale/missing materialHash,
missing signature, malformed bundle} the quorum does NOT form. There is no "soft" path — the fallback
is always full recompute / hard reject, never a relaxed accept (keeps Eq.adm un-weakened).

## 5. Key management decisions

- **Generation:** each host generates its own Ed25519 keypair locally (`authority-signing.ts`
  `generateEd25519KeyPair`); private keys never leave the host.
- **Pinning/distribution:** public keys are added to the committed manifest by an explicit operator
  action (out-of-band), not auto-trusted on first use.
- **Rotation:** manifest-versioned; a rotation adds the new key and marks the old one retired-at a
  timestamp; verdicts remain verifiable under the manifest version they cite.
- **Revocation:** a revocation list (keyId → revoked-at) makes verdicts signed after the revocation
  timestamp inadmissible; historical verdicts before revocation stay verifiable for audit.
- **Storage:** private keys via the existing local secret handling; the manifest + revocation list
  are public (they contain only public keys and timestamps).

## 6. Acceptance for M0

- [ ] Trust anchor named (pinned out-of-band manifest, verify-against-pinned-not-self).
- [ ] Independence claim + explicit ceiling stated (cross-vendor, same-operator).
- [ ] Every fail-closed rule enumerated (the §4 table) — these become M1/M2 RED tests.
- [ ] Key generation / pinning / rotation / revocation decided.
- [ ] Paper wording boundary fixed for M5 (allowed vs forbidden phrasings).
