// Roman numeral codec: encode / decode / validate, driven by one ordered value/symbol table.

// Ordered high -> low, including every standard subtractive pair.
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
  let total = 0;
  let i = 0;
  while (i < str.length) {
    let matched = false;
    for (const [value, symbol] of TABLE) {
      if (str.startsWith(symbol, i)) {
        total += value;
        i += symbol.length;
        matched = true;
        break;
      }
    }
    if (!matched) throw new Error(`Invalid Roman character: '${str[i]}'`);
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
    default:         throw new Error(`Unknown mode: '${mode}'`);
  }
}
