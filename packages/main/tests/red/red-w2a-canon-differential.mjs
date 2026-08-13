#!/usr/bin/env node
/**
 * RED artifact (W2a / B-c054, CHK-001 + CHK-002).
 *
 * Repro-first RED: this file is written and committed BEFORE
 * packages/main/src/core/red-evidence/canon.ts exists. At that point the import
 * of ../../dist/core/red-evidence/canon.js fails (ERR_MODULE_NOT_FOUND) and the
 * process exits non-zero — that import failure IS the RED evidence that the
 * §0.4 CANON has no implementation yet. Once canon.ts is implemented and built,
 * every assertion below must hold (GREEN).
 *
 * It proves two things a later reviewer must not re-litigate:
 *   1. §0.4 CANON produces RFC-8785 code-unit key order, preserves JSON null,
 *      and renders sha256:<64-hex>, matching frozen vectors.
 *   2. DIFFERENTIALLY, neither existing canonicalizer can serve as CANON:
 *        - core/digest.ts:27 sorts keys with localeCompare (NOT code-unit), so
 *          {"B":1,"a":2} canonicalizes to a DIFFERENT digest.
 *        - core/authority-signing.ts:64 maps JSON null -> undefined and DROPS
 *          the field, so a chain-founding {priorRecordDigest:null} is erased.
 *   The reason string beside each differential names the exact defect so no
 *   later story wires digest.ts / authority-signing.ts in as CANON.
 *
 * Assurance scope (§0.6 practical tier): this detects accidental substitution
 * and casual drift through the registered surfaces. It does not defend against
 * a hostile local agent with filesystem control (that is the Tier-C program).
 */
import { strict as assert } from 'node:assert';

const DIST = new URL('../../dist', import.meta.url).pathname;
const { canon, canonDigest, canonDigestOmitting, first12hex } = await import(`${DIST}/core/red-evidence/canon.js`);
const { digestCanonicalJson } = await import(`${DIST}/core/digest.js`);
const { canonicalJsonForSigning } = await import(`${DIST}/core/authority-signing.js`);

// ── Frozen CANON vectors (independently computed from RFC 8785) ───────────────
assert.equal(canon({ B: 1, a: 2 }), '{"B":1,"a":2}',
  'CANON key order is UTF-16 code-unit (0x42 "B" < 0x61 "a"), NOT localeCompare');
assert.equal(canonDigest({ B: 1, a: 2 }),
  'sha256:812e5e7fb7bb816dc477e91a136430192eadcf83ff303881298146e106ae0161',
  'canonDigest renders sha256:<64-hex> over the code-unit-ordered canonical bytes');

assert.equal(canon({ x: null }), '{"x":null}', '§0.4: JSON null is PRESERVED, never dropped');
assert.equal(canon({ v: -0 }), '{"v":0}', 'RFC 8785 minimal number: -0 renders as 0');
assert.equal(canon({ v: 1e21 }), '{"v":1e+21}', 'RFC 8785 minimal number: 1e21 renders 1e+21');
assert.equal(canon({ v: 1e-7 }), '{"v":1e-7}', 'RFC 8785 minimal number: 1e-7 renders 1e-7');
assert.equal(canon([1, null, 3]), '[1,null,3]', 'array null preserved in order');

// control-char key (U+0001) + astral-plane key (U+1D573) — code-unit sort:
// 0x0001 < 0xD835 (astral hi surrogate), so the control char sorts FIRST.
const astral = {};
astral['\u0001'] = 1;
astral['\u{1D573}'] = 2;
assert.ok(canon(astral).startsWith('{"\\u0001":1,'),
  'control-char key escapes to \\u0001 and sorts first by code unit');
assert.ok(canon(astral).includes(String.fromCodePoint(0x1D573)),
  'astral key is emitted as raw UTF-8 (RFC 8785 minimal string), sorted after the control char');
assert.equal(canonDigest(astral),
  'sha256:27fbb55752b4beb938f3ef318d30e5b0f37c326cb3650d33c507b4d71077e021',
  'frozen digest over the control-char + astral-key object');

// deeply nested null preservation + per-level key sort
assert.equal(canon({ a: { b: { c: { d: { e: null, z: 1 } } } }, m: null }),
  '{"a":{"b":{"c":{"d":{"e":null,"z":1}}}},"m":null}',
  'null preserved at every level; keys sorted at every level');

// degenerate + helper vectors
assert.equal(canonDigest({}),
  'sha256:44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a',
  'empty object has a stable frozen digest');
assert.equal(canonDigestOmitting({ a: 1, b: 2, recordDigest: 'sha256:abc' }, 'recordDigest'),
  canonDigest({ a: 1, b: 2 }),
  '§0.4 self-omitting recordDigest: digest-with-field-omitted equals canonDigest of the object without it');
assert.equal(canonDigestOmitting({ a: 1, b: 2 }, 'doesNotExist'), canonDigest({ a: 1, b: 2 }),
  'omitting an absent field is a no-op, never a throw');
assert.equal(first12hex('sha256:abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789'),
  'abcdef012345', 'first12hex takes 12 hex from the 64-hex body, EXCLUDING the sha256: prefix');

// idempotency
assert.equal(canon({ B: 1, a: 2 }), canon({ B: 1, a: 2 }), 'CANON is idempotent (byte-equal)');

// F-CX1: a lone surrogate MUST terminate canonicalization with an error
// (RFC 8785 §3.2.2.2), NOT be silently escaped.
const lone = {};
lone['\uD800'] = 1;
assert.throws(() => canon(lone), 'lone-surrogate member NAME throws (RFC 8785 §3.2.2.2)');
assert.throws(() => canon('\uD800'), 'a lone HIGH surrogate string value throws');
assert.throws(() => canon('\uDC00'), 'a lone LOW surrogate string value throws');
assert.throws(() => canon('a\uD83Dz'), 'a high surrogate not followed by a low surrogate throws');
assert.throws(() => canon('a\uDE00'), 'a low surrogate not preceded by a high surrogate throws');
// a WELL-FORMED surrogate PAIR (a real astral code point) is NOT rejected
assert.equal(canon('\u{1F600}'), JSON.stringify('\u{1F600}'), 'a valid astral surrogate PAIR canonicalizes (raw UTF-8), not rejected');

// F-002: a non-plain object (Date/Map/Set/RegExp/class instance) MUST throw,
// never silently collapse to {} and alias two distinct values to one digest.
assert.throws(() => canon({ createdAt: new Date('2020-01-01T00:00:00Z'), name: 'x' }),
  'a Date VALUE throws (no {} collapse that would alias 2020 and 2099 to one digest)');
assert.throws(() => canon(new Date('2099-01-01T00:00:00Z')), 'a top-level Date throws');
assert.throws(() => canon(new Map([['a', 1]])), 'a Map throws');
assert.throws(() => canon(new Set([1])), 'a Set throws');
assert.throws(() => canon(/re/), 'a RegExp throws');
class Foo { constructor() { this.a = 1; } }
assert.throws(() => canon(new Foo()), 'a class instance throws (prototype is not Object.prototype)');
// a null-PROTOTYPE object is still a plain JSON object for CANON (prototype === null)
assert.equal(canon(Object.assign(Object.create(null), { a: 1, b: 2 })), '{"a":1,"b":2}',
  'a null-prototype object is a plain JSON object (prototype null is allowed)');

// programming-error inputs throw (§0.4)
assert.throws(() => canon(undefined), 'canon(undefined) throws');
assert.throws(() => canon(() => {}), 'canon(function) throws');
assert.throws(() => canon({ v: NaN }), 'canon(NaN) throws (RFC 8785 rejects non-finite)');
assert.throws(() => canon({ v: Infinity }), 'canon(Infinity) throws');

// ── DIFFERENTIAL 1: digest.ts localeCompare key order ≠ CANON code-unit order ─
const canonHexB1a2 = canonDigest({ B: 1, a: 2 }).slice('sha256:'.length);
const digestTsHexB1a2 = digestCanonicalJson({ B: 1, a: 2 });
assert.notEqual(canonHexB1a2, digestTsHexB1a2,
  'REASON: digest.ts:27 localeCompare sorts {a,B} as a<B, CANON sorts B<a by code unit — different digests');
assert.equal(digestTsHexB1a2, 'f4fb4f23c18557f189581b45e08078afb6b588addef57f8b1b4c80cef4a8716d',
  'frozen digest.ts (localeCompare) digest for {B:1,a:2}, pinned to catch a silent digest.ts substitution');

// ── DIFFERENTIAL 2: authority-signing null-drop ≠ CANON null-preserve ─────────
assert.ok(canon({ priorRecordDigest: null }).includes('"priorRecordDigest":null'),
  'CANON preserves a chain-founding priorRecordDigest:null');
assert.equal(canonicalJsonForSigning({ priorRecordDigest: null }), '{}',
  'REASON: authority-signing.ts:64 maps null->undefined and DROPS priorRecordDigest — CANON must not');
// systematic (not one-field accident): {a:null,b:1}
assert.equal(canon({ a: null, b: 1 }), '{"a":null,"b":1}', 'CANON preserves every null field');
assert.equal(canonicalJsonForSigning({ a: null, b: 1 }), '{"b":1}',
  'authority-signing drops ALL null fields systematically, not just priorRecordDigest');

console.log('red-w2a-canon-differential: PASS');
