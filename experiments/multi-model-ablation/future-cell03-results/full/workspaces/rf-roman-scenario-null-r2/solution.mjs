const ROMAN_TABLE = [
  [1000, 'M'],
  [900, 'CM'],
  [500, 'D'],
  [400, 'CD'],
  [100, 'C'],
  [90, 'XC'],
  [50, 'L'],
  [40, 'XL'],
  [10, 'X'],
  [9, 'IX'],
  [5, 'V'],
  [4, 'IV'],
  [1, 'I'],
];

function encode(input) {
  if (!Number.isInteger(input) || input < 1 || input > 3999) {
    throw new RangeError('encode input must be an integer from 1 to 3999');
  }

  let remaining = input;
  let result = '';

  for (const [value, symbol] of ROMAN_TABLE) {
    while (remaining >= value) {
      result += symbol;
      remaining -= value;
    }
  }

  return result;
}

function decode(input) {
  if (typeof input !== 'string' || input.length === 0 || /[^IVXLCDM]/i.test(input)) {
    throw new Error('decode input must be a non-empty Roman numeral string');
  }

  const source = input.toUpperCase();
  let index = 0;
  let total = 0;

  while (index < source.length) {
    for (const [value, symbol] of ROMAN_TABLE) {
      if (source.startsWith(symbol, index)) {
        total += value;
        index += symbol.length;
        break;
      }
    }
  }

  return total;
}

function validate(input) {
  try {
    return typeof input === 'string' && encode(decode(input)) === input.toUpperCase();
  } catch {
    return false;
  }
}

export default function roman(mode, input) {
  if (mode === 'encode') return encode(input);
  if (mode === 'decode') return decode(input);
  if (mode === 'validate') return validate(input);
  throw new Error(`unknown mode: ${mode}`);
}
