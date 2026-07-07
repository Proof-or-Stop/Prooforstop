// slugify: turn an arbitrary title into a clean lowercase hyphen-separated URL slug.

const FOLD = {
  À: 'a', Á: 'a', Â: 'a', Ã: 'a', Ä: 'a', Å: 'a',
  à: 'a', á: 'a', â: 'a', ã: 'a', ä: 'a', å: 'a',
  È: 'e', É: 'e', Ê: 'e', Ë: 'e',
  è: 'e', é: 'e', ê: 'e', ë: 'e',
  Ì: 'i', Í: 'i', Î: 'i', Ï: 'i',
  ì: 'i', í: 'i', î: 'i', ï: 'i',
  Ò: 'o', Ó: 'o', Ô: 'o', Õ: 'o', Ö: 'o',
  ò: 'o', ó: 'o', ô: 'o', õ: 'o', ö: 'o',
  Ù: 'u', Ú: 'u', Û: 'u', Ü: 'u',
  ù: 'u', ú: 'u', û: 'u', ü: 'u',
  Ñ: 'n', Ç: 'c',
  ñ: 'n', ç: 'c',
};

function slugChar(ch) {
  if (ch >= 'A' && ch <= 'Z') return String.fromCharCode(ch.charCodeAt(0) + 32);
  if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) return ch;
  if (Object.prototype.hasOwnProperty.call(FOLD, ch)) return FOLD[ch];
  return '';
}

export default function slugify(input) {
  if (typeof input !== 'string') {
    throw new TypeError('slugify expects a string, got ' + typeof input);
  }

  let result = '';
  let pendingSep = false;

  for (const raw of input) {
    const ch = slugChar(raw);
    if (ch) {
      if (pendingSep && result) result += '-';
      result += ch;
      pendingSep = false;
    } else if (result) {
      pendingSep = true;
    }
  }

  return result;
}
