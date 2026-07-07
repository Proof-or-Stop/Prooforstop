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
  ñ: 'n', Ñ: 'n',
  ç: 'c', Ç: 'c',
};

function isAsciiDigit(code) {
  return code >= 48 && code <= 57;
}

function isAsciiLower(code) {
  return code >= 97 && code <= 122;
}

function isAsciiUpper(code) {
  return code >= 65 && code <= 90;
}

export default function slugify(input) {
  let slug = '';
  let needsHyphen = false;

  for (const raw of input) {
    const code = raw.charCodeAt(0);
    let ch = '';

    if (isAsciiDigit(code) || isAsciiLower(code)) {
      ch = raw;
    } else if (isAsciiUpper(code)) {
      ch = String.fromCharCode(code + 32);
    } else if (Object.prototype.hasOwnProperty.call(FOLD, raw)) {
      ch = FOLD[raw];
    }

    if (ch) {
      if (needsHyphen && slug) {
        slug += '-';
      }
      slug += ch;
      needsHyphen = false;
    } else if (slug) {
      needsHyphen = true;
    }
  }

  return slug;
}
