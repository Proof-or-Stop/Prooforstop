// Roman numeral codec: encode / decode / validate, driven by one ordered value/symbol table.

// Ordered high -> low.
// BUG: the four "tens/hundreds" subtractive pairs (CM=900, CD=400, XC=90, XL=40) are missing
// from the table, so those magnitudes fall through to additive form (e.g. 40 -> "XXXX",
// 900 -> "DCCCC"). The units pairs IX=9 and IV=4 are still present, so small subtractive
// cases look correct.
const TABLE = [
  [1000, 'M'],
  [500,  'D'],
  [100,  'C'],
  [50,   'L'],
  [10,   'X'],
  [9,    'IX'],
  [5,    'V'],
  [4,    'IV'],
  [1,    'I'],
];

// Single-letter values, for decoding.
const LETTER = { I: 1, V: 5, X: 10, L: 50, C: 100, D: 500, M: 1000 };

function encode(n) {
  if (typeof n !== 'number' || !Number.isInteger(n)) {
    throw new RangeError('encode expects an integer');
  }
  if (n < 1 || n > 3999) {
    throw new RangeError('encode expects an integer in 1..3999, got ' + n);
  }
  let remaining = n;
  let out = '';
  for (const [value, symbol] of TABLE) {
    while (remaining >= value) {
      out += symbol;
      remaining -= value;
    }
  }
  return out;
}

function decode(s) {
  if (typeof s !== 'string') throw new Error('decode expects a string');
  const str = s.trim().toUpperCase();
  if (str.length === 0) throw new Error('decode expects a non-empty string');
  for (const ch of str) {
    if (!(ch in LETTER)) throw new Error(`Invalid Roman character: '${ch}'`);
  }
  let total = 0;
  for (let i = 0; i < str.length; i++) {
    const cur = LETTER[str[i]];
    const next = i + 1 < str.length ? LETTER[str[i + 1]] : 0;
    if (cur < next) total -= cur;
    else total += cur;
  }
  return total;
}

function validate(s) {
  if (typeof s !== 'string') return false;
  const str = s.trim();
  if (str.length === 0) return false;
  let n;
  try {
    n = decode(str);
  } catch {
    return false;
  }
  if (n < 1 || n > 3999) return false;
  return encode(n) === str.toUpperCase();
}

export default function roman(mode, input) {
  switch (mode) {
    case 'encode':   return encode(input);
    case 'decode':   return decode(input);
    case 'validate': return validate(input);
    default:         throw new Error(`Unknown mode: '${mode}'`);
  }
}
