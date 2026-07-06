// slugify: turn an arbitrary title into a clean lowercase hyphen-separated URL slug.
// Approach: fold allowed accents, lowercase ASCII letters, map non-alphanumerics
// to a separator marker, then collapse separator runs into single hyphens.

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

function isAlnum(ch) {
  return (ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9');
}

function normalizeChar(ch) {
  if (ch >= 'A' && ch <= 'Z') {
    return String.fromCharCode(ch.charCodeAt(0) + 32);
  }
  if (Object.prototype.hasOwnProperty.call(FOLD, ch)) return FOLD[ch];
  return ch;
}

export default function slugify(input) {
  if (typeof input !== 'string') {
    throw new TypeError('slugify expects a string, got ' + typeof input);
  }

  // Step 1: build a normalized character stream where every character is either an
  // allowed alphanumeric or the separator sentinel ' '.
  const stream = [];
  for (const raw of input) {
    const ch = normalizeChar(raw);
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
      pendingSep = out.length > 0;
      continue;
    }
    if (pendingSep) {
      out.push('-');
      pendingSep = false;
    }
    out.push(ch);
  }

  // Step 3: a trailing run of separators must not produce a trailing hyphen, so
  // do not flush a pending separator at the end.
  return out.join('');
}
