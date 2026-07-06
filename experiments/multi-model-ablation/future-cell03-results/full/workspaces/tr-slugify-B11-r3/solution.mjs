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
  ñ: 'n', Ñ: 'n', ç: 'c', Ç: 'c',
};

function normalizeChar(ch) {
  const code = ch.charCodeAt(0);
  if (code >= 48 && code <= 57) return ch;
  if (code >= 65 && code <= 90) return String.fromCharCode(code + 32);
  if (code >= 97 && code <= 122) return ch;
  if (Object.prototype.hasOwnProperty.call(FOLD, ch)) return FOLD[ch];
  return null;
}

export default function slugify(input) {
  const text = input == null ? '' : String(input);

  // Step 1: build a normalized character stream where every character is either an
  // allowed alphanumeric or the separator sentinel ' '.
  const stream = [];
  for (const raw of text) {
    const ch = normalizeChar(raw);
    if (ch !== null) {
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
      pendingSep = true;
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
  // because the first alphanumeric resets pendingSep before emitting any hyphen…
  // but the very first emitted hyphen would be leading, so strip a leading hyphen too.
  let result = out.join('');
  if (result.startsWith('-')) result = result.slice(1);
  if (result.endsWith('-')) result = result.slice(0, -1);

  return result;
}
