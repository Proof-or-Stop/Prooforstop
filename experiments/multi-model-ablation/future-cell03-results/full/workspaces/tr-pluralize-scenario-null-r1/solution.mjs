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

export default function pluralize(word) {
  if (irregulars.has(word)) {
    return irregulars.get(word);
  }

  if (uncountables.has(word)) {
    return word;
  }

  if (
    word.endsWith("s") ||
    word.endsWith("ss") ||
    word.endsWith("sh") ||
    word.endsWith("ch") ||
    word.endsWith("x") ||
    word.endsWith("z")
  ) {
    return `${word}es`;
  }

  const previous = word.at(-2);

  if (word.endsWith("y")) {
    return previous && !vowels.has(previous)
      ? `${word.slice(0, -1)}ies`
      : `${word}s`;
  }

  if (word.endsWith("o")) {
    return previous && !vowels.has(previous) ? `${word}es` : `${word}s`;
  }

  if (word.endsWith("fe")) {
    return `${word.slice(0, -2)}ves`;
  }

  if (word.endsWith("f")) {
    return `${word.slice(0, -1)}ves`;
  }

  return `${word}s`;
}
