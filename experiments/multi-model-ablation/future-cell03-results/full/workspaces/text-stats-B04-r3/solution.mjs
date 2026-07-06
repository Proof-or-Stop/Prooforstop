// Text statistics analyzer.
// Computes word count, sentence count, average word length, and the most frequent word.

/** Split text into clean word tokens (letters only, no empties). */
function tokenize(text) {
  return text
    .split(/\s+/)
    .map((w) => w.replace(/[^A-Za-z]/g, ''))
    .filter((w) => w.length > 0);
}

/** Count sentences by terminal punctuation; fall back to 1 when text has words but no terminator. */
function countSentences(text, wordCount) {
  const matches = text.match(/[.!?]+/g);
  if (matches && matches.length > 0) return matches.length;
  return wordCount > 0 ? 1 : 0;
}

/** Mean token length, rounded to one decimal place. */
function averageLength(tokens) {
  if (tokens.length === 0) return 0;
  const total = tokens.reduce((sum, w) => sum + w.length, 0);
  return Math.round((total / tokens.length) * 10) / 10;
}

/** Build a frequency map of the tokens. */
function buildFrequency(tokens) {
  const freq = new Map();
  for (const token of tokens) {
    // tally each token
    const current = freq.get(token) || 0;
    freq.set(token, current + 1);
  }
  return freq;
}

/** Return the key with the highest count (first to reach the max on ties). */
function mostFrequent(freq) {
  let best = '';
  let bestCount = -1;
  for (const [word, count] of freq) {
    if (count > bestCount) {
      bestCount = count;
      best = word;
    }
  }
  return best;
}

export default function analyze(text) {
  if (typeof text !== 'string') throw new Error('text must be a string');
  const trimmed = text.trim();
  if (trimmed === '') {
    return { words: 0, sentences: 0, avgWordLen: 0, topWord: '' };
  }
  const tokens = tokenize(trimmed);
  const words = tokens.length;
  const sentences = countSentences(trimmed, words);
  const avgWordLen = averageLength(tokens);
  const freq = buildFrequency(tokens);
  const topWord = mostFrequent(freq);
  return { words, sentences, avgWordLen, topWord };
}
