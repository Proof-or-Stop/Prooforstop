const ROMAN_TABLE = Object.freeze([
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
]);

const SINGLE_VALUES = new Map(
  ROMAN_TABLE
    .filter(([, symbol]) => symbol.length === 1)
    .map(([value, symbol]) => [symbol, value]),
);

function encodeRoman(number) {
  if (!Number.isInteger(number) || number < 1 || number > 3999) {
    throw new RangeError('encode input must be an integer from 1 to 3999');
  }

  let remaining = number;
  let result = '';

  for (const [value, symbol] of ROMAN_TABLE) {
    while (remaining >= value) {
      result += symbol;
      remaining -= value;
    }
  }

  return result;
}

function normalizeRoman(input) {
  if (typeof input !== 'string') {
    throw new Error('decode input must be a string');
  }

  if (input.length === 0) {
    throw new Error('Roman numeral cannot be empty');
  }

  let roman = '';
  for (const character of input) {
    const symbol = character.toUpperCase();
    if (
      !SINGLE_VALUES.has(symbol)
      || (character !== symbol && character !== symbol.toLowerCase())
    ) {
      throw new Error('Roman numeral contains invalid characters');
    }
    roman += symbol;
  }

  return roman;
}

function decodeRoman(input) {
  const roman = normalizeRoman(input);
  let total = 0;

  for (let index = 0; index < roman.length; index += 1) {
    const current = SINGLE_VALUES.get(roman[index]);
    const next = SINGLE_VALUES.get(roman[index + 1]) ?? 0;

    total += current < next ? -current : current;
  }

  return total;
}

function validateRoman(input) {
  if (typeof input !== 'string') {
    return false;
  }

  try {
    return encodeRoman(decodeRoman(input)) === input.toUpperCase();
  } catch {
    return false;
  }
}

export default function roman(mode, input) {
  switch (mode) {
    case 'encode':
      return encodeRoman(input);
    case 'decode':
      return decodeRoman(input);
    case 'validate':
      return validateRoman(input);
    default:
      throw new Error(`unknown mode: ${mode}`);
  }
}
