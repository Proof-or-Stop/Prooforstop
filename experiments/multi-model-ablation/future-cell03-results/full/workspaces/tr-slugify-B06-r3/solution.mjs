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

  // Step 1: build a normalized character stream where every character is either an
  // allowed alphanumeric or the separator sentinel ' '.
  const stream = [];
  for (const raw of lowered) {
    const ch = foldChar(raw);
    if (isAlnum(ch)) {
      stream.push(ch);
    } else {
      stream.push(' ');
    }
  }

  // Step 2: walk the stream, emitting a single hyphen for each maximal run of
  // separators, and copying alphanumerics through verbatim.
  const out = [];
  let pendingSep = false;
  for (const ch of stream) {
    if (ch === ' ') {
      if (out.length > 0) pendingSep = true;
      continue;
    }
    if (pendingSep) {
      out.push('-');
      pendingSep = false;
    }
    out.push(ch);
  }

  // Step 3: a trailing run of separators must NOT produce a trailing hyphen, so we
  // never flush a pending separator at the end. Leading separators are handled
  // by only marking a separator as pending after output has started.
  let result = out.join('');

  return result;
}
