// Pragmatic email (addr-spec) validator: local-part "@" domain.
//
// Returns true/false for any string input; throws TypeError for non-string input.
// Validates an unquoted dot-atom local part and a dot-separated domain with a letters-only TLD.

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const DIGITS = '0123456789';

// Atom punctuation permitted in an unquoted local-part (RFC 5321/5322 dot-atom subset).
// Includes '+' (used for plus / sub-addressing, e.g. "user+tag@example.com").
const LOCAL_ATOM_PUNCT = "!#$%&'*-/=?^_`{|}~";

function buildSet(...chunks) {
  const s = new Set();
  for (const chunk of chunks) for (const ch of chunk) s.add(ch);
  return s;
}

const LOCAL_CHARS = buildSet(LETTERS, DIGITS, LOCAL_ATOM_PUNCT);
const LABEL_CHARS = buildSet(LETTERS, DIGITS, '-');

function isLetter(ch) {
  return LETTERS.indexOf(ch) !== -1;
}

function validateLocalPart(local) {
  if (local.length < 1 || local.length > 64) return false;
  if (local[0] === '.' || local[local.length - 1] === '.') return false;
  for (let i = 0; i < local.length; i++) {
    const ch = local[i];
    if (ch === '.') {
      // no consecutive dots
      if (i + 1 < local.length && local[i + 1] === '.') return false;
      continue;
    }
    if (!LOCAL_CHARS.has(ch)) return false;
  }
  return true;
}

function validateLabel(label) {
  if (label.length < 1 || label.length > 63) return false;
  if (label[0] === '-' || label[label.length - 1] === '-') return false;
  for (let i = 0; i < label.length; i++) {
    if (!LABEL_CHARS.has(label[i])) return false;
  }
  return true;
}

function validateDomain(domain) {
  if (domain.length < 1 || domain.length > 255) return false;
  if (domain[0] === '.' || domain[domain.length - 1] === '.') return false;
  const labels = domain.split('.');
  if (labels.length < 2) return false; // must contain at least one dot
  for (const label of labels) {
    if (!validateLabel(label)) return false;
  }
  // TLD: final label must be all letters, length >= 2
  const tld = labels[labels.length - 1];
  if (tld.length < 2) return false;
  for (let i = 0; i < tld.length; i++) {
    if (!isLetter(tld[i])) return false;
  }
  return true;
}

export default function validateEmail(input) {
  if (typeof input !== 'string') {
    throw new TypeError('validateEmail expects a string, got ' + typeof input);
  }

  // Exactly one '@'.
  let atCount = 0;
  let atIndex = -1;
  for (let i = 0; i < input.length; i++) {
    if (input[i] === '@') { atCount++; atIndex = i; }
  }
  if (atCount !== 1) return false;

  const local = input.slice(0, atIndex);
  const domain = input.slice(atIndex + 1);

  if (!validateLocalPart(local)) return false;
  if (!validateDomain(domain)) return false;

  return true;
}
