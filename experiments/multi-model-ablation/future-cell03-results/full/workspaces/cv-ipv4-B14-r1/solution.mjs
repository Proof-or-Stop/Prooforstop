// IPv4 dotted-decimal validator/parser.
//
// Grammar (informal):
//   address := octet '.' octet '.' octet '.' octet
//   octet   := '0' | [1-9][0-9]{0,2}     ; value 0..255, canonical (no redundant leading zero)
//
// On success returns [a, b, c, d] as numbers; on any contract violation throws an Error.

const DIGITS = '0123456789';

function isDigit(ch) {
  return ch !== undefined && DIGITS.indexOf(ch) !== -1;
}

// Split on '.' WITHOUT collapsing empties, so we can detect empty octets,
// leading/trailing dots, and doubled dots precisely.
function splitOctets(str) {
  const parts = [];
  let current = '';
  let sawDot = false;
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (ch === '.') {
      parts.push(current);
      current = '';
      sawDot = true;
    } else {
      current += ch;
    }
  }
  parts.push(current);
  // Mark that there was at least one separator so a single bare token is distinguishable.
  return { parts, sawDot };
}

function validateOctetText(text) {
  // Must be a non-empty run of ASCII digits only.
  if (text.length === 0) {
    throw new Error('empty octet');
  }
  for (let i = 0; i < text.length; i++) {
    if (!isDigit(text[i])) {
      throw new Error(`octet "${text}" contains a non-digit character`);
    }
  }
  // Length guard: a canonical octet is at most 3 characters.
  if (text.length > 3) {
    throw new Error(`octet "${text}" is too long`);
  }
  // Canonical-form check: reject redundant leading zeros.
  // The only octet permitted to start with '0' is the single character "0".
  if (text.length > 2 && text[0] === '0') {
    throw new Error(`octet "${text}" has a redundant leading zero`);
  }
  return text;
}

function octetToNumber(text) {
  let value = 0;
  for (let i = 0; i < text.length; i++) {
    value = value * 10 + DIGITS.indexOf(text[i]);
  }
  if (value < 0 || value > 255) {
    throw new Error(`octet "${text}" is out of range 0..255`);
  }
  return value;
}

export default function parseIPv4(input) {
  if (typeof input !== 'string') {
    throw new TypeError('parseIPv4 expects a string, got ' + typeof input);
  }

  const { parts } = splitOctets(input);

  if (parts.length !== 4) {
    throw new Error(`expected exactly 4 octets, got ${parts.length}`);
  }

  const out = [];
  for (let k = 0; k < parts.length; k++) {
    const text = validateOctetText(parts[k]);
    out.push(octetToNumber(text));
  }

  return out;
}
