// Payment-card account-number validator using the Luhn (mod-10) checksum.
//
// Pipeline: type-check -> strip separators -> validate charset & length -> Luhn check.
// Returns true/false for well-formed inputs; throws for malformed inputs.

const DIGIT_RE = /^[0-9]+$/;
const SEPARATORS = new Set([' ', '-']);

function stripSeparators(str) {
  let out = '';
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (SEPARATORS.has(ch)) continue;
    out += ch;
  }
  return out;
}

function assertWellFormed(digits, original) {
  if (!DIGIT_RE.test(digits)) {
    throw new Error(`"${original}" contains characters other than digits and separators`);
  }
  if (digits.length < 2 || digits.length > 19) {
    throw new Error(`"${original}" has an invalid length (${digits.length}); must be 2..19`);
  }
}

// Map a single digit to its Luhn contribution when doubled (subtract 9 if > 9).
function doubledValue(d) {
  const doubled = d * 2;
  return doubled > 9 ? doubled - 9 : doubled;
}

function luhnTotal(digits) {
  const n = digits.length;
  let total = 0;
  // Walk from the RIGHTMOST digit leftward. posFromRight = 0 for the last digit.
  for (let posFromRight = 0; posFromRight < n; posFromRight++) {
    const idx = n - 1 - posFromRight;
    const d = digits.charCodeAt(idx) - 48; // '0' === 48
    // Double every SECOND digit counting from the right: posFromRight 1, 3, 5, ...
    const shouldDouble = (posFromRight % 2) === 1;
    total += shouldDouble ? doubledValue(d) : d;
  }
  return total;
}

export default function validateCardNumber(input) {
  if (typeof input !== 'string') {
    throw new TypeError('validateCardNumber expects a string, got ' + typeof input);
  }

  const digits = stripSeparators(input);
  assertWellFormed(digits, input);

  const total = luhnTotal(digits);
  return (total % 10) === 0;
}
