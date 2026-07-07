// slugify: turn an arbitrary title into a clean lowercase hyphen-separated URL slug.

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

function isAlnum(ch) {
  return (ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9');
}

function normalizeChar(ch) {
  if (ch >= 'A' && ch <= 'Z') return ch.toLowerCase();
  if (Object.prototype.hasOwnProperty.call(FOLD, ch)) return FOLD[ch];
  return ch;
}

export default function slugify(input) {
  if (typeof input !== 'string') {
    throw new TypeError('slugify expects a string, got ' + typeof input);
  }

  let result = '';
  let pendingSeparator = false;

  for (const raw of input) {
    const ch = normalizeChar(raw);

    if (isAlnum(ch)) {
      if (pendingSeparator && result !== '') result += '-';
      result += ch;
      pendingSeparator = false;
    } else if (result !== '') {
      pendingSeparator = true;
    }
  }

  return result;
}
