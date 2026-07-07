// slugify: turn an arbitrary title into a clean lowercase hyphen-separated URL slug.
// Approach: fold accents, lowercase, map non-alphanumerics to a separator marker, then
// collapse runs of separators into a single hyphen and trim leading/trailing hyphens.

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
  ñ: 'n', ç: 'c',
  Ñ: 'n', Ç: 'c',
};

function slugChar(ch) {
  if (ch >= 'A' && ch <= 'Z') {
    return String.fromCharCode(ch.charCodeAt(0) + 32);
  }
  if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) {
    return ch;
  }
  if (Object.prototype.hasOwnProperty.call(FOLD, ch)) {
    return FOLD[ch];
  }
  return '';
}

export default function slugify(input) {
  if (typeof input !== 'string') {
    throw new TypeError('slugify expects a string, got ' + typeof input);
  }

  const out = [];
  let pendingHyphen = false;

  for (const raw of input) {
    const ch = slugChar(raw);
    if (ch === '') {
      pendingHyphen = out.length > 0;
      continue;
    }

    if (pendingHyphen) {
      out.push('-');
      pendingHyphen = false;
    }
    out.push(ch);
  }

  return out.join('');
}
