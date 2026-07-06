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
    throw new RangeError('input must be an integer from 1 to 3999');
  }

  let remaining = input;
  let output = '';

  for (const [value, symbol] of ROMAN_TABLE) {
    while (remaining >= value) {
      output += symbol;
      remaining -= value;
    }
  }

  return output;
}

function decode(input) {
  if (typeof input !== 'string' || input.length === 0 || /[^IVXLCDM]/i.test(input)) {
    throw new Error('input must be a non-empty Roman numeral string');
  }

  const text = input.toUpperCase();
  let index = 0;
  let total = 0;

  while (index < text.length) {
    const entry = ROMAN_TABLE.find(([, symbol]) => text.startsWith(symbol, index));
    total += entry[0];
    index += entry[1].length;
  }

  return total;
}

export default function roman(mode, input) {
  if (mode === 'encode') {
    return encode(input);
  }

  if (mode === 'decode') {
    return decode(input);
  }

  if (mode === 'validate') {
    if (typeof input !== 'string') {
      return false;
    }

    try {
      const value = decode(input);
      return value <= 3999 && encode(value) === input.toUpperCase();
    } catch {
      return false;
    }
  }

  throw new Error(`unknown mode: ${mode}`);
}
