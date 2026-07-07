// slugify: turn an arbitrary title into a clean lowercase hyphen-separated URL slug.
// Approach: fold accents, lowercase, map non-alphanumerics to a separator marker, then
// collapse runs of separators into a single hyphen and trim leading/trailing hyphens.

const FOLD = {
  à: 'a', á: 'a', â: 'a', ã: 'a', ä: 'a', å: 'a',
  è: 'e', é: 'e', ê: 'e', ë: 'e',
  ì: 'i', í: 'i', î: 'i', ï: 'i',
  ò: 'o', ó: 'o', ô: 'o', õ: 'o', ö: 'o',
  ù: 'u', ú: 'u', û: 'u', ü: 'u',
  ñ: 'n', ç: 'c',
};

function isAlnum(ch) {
  return (ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9');
}

function foldChar(ch) {
  // Already lowered before this is called.
  if (Object.prototype.hasOwnProperty.call(FOLD, ch)) return FOLD[ch];
  return ch;
}

export default function slugify(input) {
  if (typeof input !== 'string') {
    throw new TypeError('slugify expects a string, got ' + typeof input);
  }

  const lowered = input.toLowerCase();

  // Walk the normalized characters, keeping one pending separator between
  // alphanumeric runs and ignoring leading/trailing separators.
  const out = [];
  let pendingSep = false;
  for (const raw of lowered) {
    const ch = foldChar(raw);
    if (isAlnum(ch)) {
      if (pendingSep && out.length > 0) {
        out.push('-');
      }
      out.push(ch);
      pendingSep = false;
    } else {
      pendingSep = out.length > 0;
    }
  }

  return out.join('');
}
