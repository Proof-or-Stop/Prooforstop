// slugify: turn an arbitrary title into a clean lowercase hyphen-separated URL slug.
// Approach: lowercase, fold common Latin-1 accents, and emit at most one hyphen
// between alphanumeric runs.

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
  const out = [];
  let needsHyphen = false;

  for (const raw of lowered) {
    const ch = foldChar(raw);
    if (isAlnum(ch)) {
      if (needsHyphen && out.length > 0) out.push('-');
      out.push(ch);
      needsHyphen = false;
    } else if (out.length > 0) {
      needsHyphen = true;
    }
  }

  return out.join('');
}
