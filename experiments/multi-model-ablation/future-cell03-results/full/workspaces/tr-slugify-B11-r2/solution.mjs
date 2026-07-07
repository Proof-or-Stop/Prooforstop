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

export default function slugify(input) {
  if (typeof input !== 'string') {
    throw new TypeError('slugify expects a string, got ' + typeof input);
  }

  const out = [];
  let needsHyphen = false;

  for (const raw of input) {
    let ch = raw;

    if (ch >= 'A' && ch <= 'Z') {
      ch = String.fromCharCode(ch.charCodeAt(0) + 32);
    } else if (Object.prototype.hasOwnProperty.call(FOLD, ch)) {
      ch = FOLD[ch];
    }

    const isAlnum = (ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9');
    if (!isAlnum) {
      needsHyphen = out.length > 0;
      continue;
    }

    if (needsHyphen) {
      out.push('-');
      needsHyphen = false;
    }
    out.push(ch);
  }

  return out.join('');
}
