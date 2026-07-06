// pluralize: regular English noun pluralizer over lowercase ASCII words.
// Rules are applied in priority order; the first matching rule wins.

const IRREGULARS = {
  man: 'men',
  woman: 'women',
  child: 'children',
  person: 'people',
  mouse: 'mice',
  tooth: 'teeth',
  foot: 'feet',
  goose: 'geese',
};

const UNCOUNTABLE = new Set(['sheep', 'fish', 'series', 'species', 'deer']);

const VOWELS = new Set(['a', 'e', 'i', 'o', 'u']);

function isVowel(ch) {
  return VOWELS.has(ch);
}

function endsWithAny(word, suffixes) {
  for (const s of suffixes) {
    if (word.endsWith(s)) return true;
  }
  return false;
}

export default function pluralize(word) {
  if (typeof word !== 'string') {
    throw new TypeError('pluralize expects a string, got ' + typeof word);
  }
  if (word.length === 0) {
    throw new Error('pluralize expects a non-empty word');
  }

  // Rule 1: irregular nouns.
  if (Object.prototype.hasOwnProperty.call(IRREGULARS, word)) {
    return IRREGULARS[word];
  }

  // Rule 2: uncountable / unchanged.
  if (UNCOUNTABLE.has(word)) {
    return word;
  }

  // Rule 3: sibilant clusters take -es.
  if (endsWithAny(word, ['s', 'ss', 'sh', 'ch', 'x', 'z'])) {
    return word + 'es';
  }

  const last = word[word.length - 1];
  const penult = word.length >= 2 ? word[word.length - 2] : '';

  // Rule 4: terminal -y.
  if (last === 'y') {
    if (penult !== '' && isVowel(penult)) {
      // vowel + y  ->  -s
      return word + 's';
    }
    // consonant + y  ->  -ies
    return word.slice(0, -1) + 'ies';
  }

  // Rule 5: terminal -o.
  if (last === 'o') {
    if (penult !== '' && !isVowel(penult)) {
      // consonant + o  ->  -es
      return word + 'es';
    }
    // vowel + o  ->  -s
    return word + 's';
  }

  // Rule 6: -f / -fe  ->  -ves.
  if (word.endsWith('fe')) {
    return word.slice(0, -2) + 'ves';
  }
  if (word.endsWith('f')) {
    return word.slice(0, -1) + 'ves';
  }

  // Rule 7: default.
  return word + 's';
}
