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

function normalizeAlnum(ch) {
  const code = ch.charCodeAt(0);
  if (code >= 65 && code <= 90) return String.fromCharCode(code + 32);
  if ((code >= 97 && code <= 122) || (code >= 48 && code <= 57)) return ch;
  if (Object.prototype.hasOwnProperty.call(FOLD, ch)) return FOLD[ch];
  return '';
}

export default function slugify(input) {
  if (typeof input !== 'string') {
    throw new TypeError('slugify expects a string, got ' + typeof input);
  }

  // Emit a pending separator only when another alphanumeric follows it. This
  // collapses separator runs and naturally trims leading/trailing hyphens.
  let result = '';
  let pendingSep = false;
  for (const raw of input) {
    const ch = normalizeAlnum(raw);
    if (ch === '') {
      if (result !== '') pendingSep = true;
      continue;
    }
    if (pendingSep) {
      result += '-';
      pendingSep = false;
    }
    result += ch;
  }

  return result;
}
