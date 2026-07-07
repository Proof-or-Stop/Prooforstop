// Roman numeral codec: encode / decode / validate, driven by one ordered value/symbol table.

// Ordered high -> low.
const TABLE = [
  [1000, 'M'],
  [900,  'CM'],
  [500,  'D'],
  [400,  'CD'],
  [100,  'C'],
  [90,   'XC'],
  [50,   'L'],
  [40,   'XL'],
  [10,   'X'],
  [9,    'IX'],
  [5,    'V'],
  [4,    'IV'],
  [1,    'I'],
];

// Single-letter values, derived from the same table for decoding.
const LETTER = Object.fromEntries(
  TABLE.filter(([, symbol]) => symbol.length === 1).map(([value, symbol]) => [symbol, value]),
);

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
  const str = s.toUpperCase();
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
  const str = s;
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
    default:         throw new Error('Unknown mode');
  }
}
