const FOLD = {
  à: 'a', á: 'a', â: 'a', ã: 'a', ä: 'a', å: 'a',
  À: 'a', Á: 'a', Â: 'a', Ã: 'a', Ä: 'a', Å: 'a',
  è: 'e', é: 'e', ê: 'e', ë: 'e',
  È: 'e', É: 'e', Ê: 'e', Ë: 'e',
  ì: 'i', í: 'i', î: 'i', ï: 'i',
  Ì: 'i', Í: 'i', Î: 'i', Ï: 'i',
  ò: 'o', ó: 'o', ô: 'o', õ: 'o', ö: 'o',
  Ò: 'o', Ó: 'o', Ô: 'o', Õ: 'o', Ö: 'o',
  ù: 'u', ú: 'u', û: 'u', ü: 'u',
  Ù: 'u', Ú: 'u', Û: 'u', Ü: 'u',
  ñ: 'n', Ñ: 'n', ç: 'c', Ç: 'c',
};

function isAsciiDigit(ch) {
  return ch >= '0' && ch <= '9';
}

function isAsciiLower(ch) {
  return ch >= 'a' && ch <= 'z';
}

function isAsciiUpper(ch) {
  return ch >= 'A' && ch <= 'Z';
}

function lowerAscii(ch) {
  return String.fromCharCode(ch.charCodeAt(0) + 32);
}

function appendSeparator(out) {
  if (out.length > 0 && out[out.length - 1] !== '-') {
    out.push('-');
  }
}

export default function slugify(input) {
  if (typeof input !== 'string') {
    throw new TypeError('slugify expects a string, got ' + typeof input);
  }

  const out = [];
  for (const raw of input) {
    if (isAsciiLower(raw) || isAsciiDigit(raw)) {
      out.push(raw);
    } else if (isAsciiUpper(raw)) {
      out.push(lowerAscii(raw));
    } else if (Object.prototype.hasOwnProperty.call(FOLD, raw)) {
      out.push(FOLD[raw]);
    } else {
      appendSeparator(out);
    }
  }

  if (out[out.length - 1] === '-') {
    out.pop();
  }

  return out.join('');
}
