const irregulars = new Map([
  ["man", "men"],
  ["woman", "women"],
  ["child", "children"],
  ["person", "people"],
  ["mouse", "mice"],
  ["tooth", "teeth"],
  ["foot", "feet"],
  ["goose", "geese"],
]);

const uncountables = new Set(["sheep", "fish", "series", "species", "deer"]);
const vowels = new Set(["a", "e", "i", "o", "u"]);

function hasConsonantBefore(word, suffixLength) {
  const index = word.length - suffixLength - 1;
  return index >= 0 && !vowels.has(word[index]);
}

export default function pluralize(word) {
  if (irregulars.has(word)) {
    return irregulars.get(word);
  }

  if (uncountables.has(word)) {
    return word;
  }

  if (
    word.endsWith("s") ||
    word.endsWith("sh") ||
    word.endsWith("ch") ||
    word.endsWith("x") ||
    word.endsWith("z")
  ) {
    return `${word}es`;
  }

  if (word.endsWith("y") && hasConsonantBefore(word, 1)) {
    return `${word.slice(0, -1)}ies`;
  }

  if (word.endsWith("o") && hasConsonantBefore(word, 1)) {
    return `${word}es`;
  }

  if (word.endsWith("fe")) {
    return `${word.slice(0, -2)}ves`;
  }

  if (word.endsWith("f")) {
    return `${word.slice(0, -1)}ves`;
  }

  return `${word}s`;
}
