// Text statistics analyzer.
// Computes word count, sentence count, average word length, and the most frequent word.

/** Split text into clean word tokens (letters only, no empties). */
function tokenize(text) {
  return text
    .split(/\s+/)
    .map((w) => w.replace(/[^\p{L}]/gu, ''))
    .filter((w) => w.length > 0);
}

/** Count sentences by terminal punctuation; fall back to 1 for non-empty unterminated text. */
function countSentences(text) {
  const matches = text.match(/[.!?]+/g);
  if (matches && matches.length > 0) return matches.length;
  return text.length > 0 ? 1 : 0;
}

/** Mean token length, rounded to one decimal place. */
function averageLength(tokens) {
  if (tokens.length === 0) return 0;
  const total = tokens.reduce((sum, w) => sum + w.length, 0);
  return Math.round((total / tokens.length) * 10) / 10;
}

/** Return the lower-case most frequent token; first to reach the winning count wins. */
function mostFrequent(tokens) {
  const freq = new Map();
  let best = '';
  let bestCount = 0;

  for (const token of tokens) {
    const normalized = token.toLowerCase();
    const count = (freq.get(normalized) || 0) + 1;
    freq.set(normalized, count);
    if (count > bestCount) {
      bestCount = count;
      best = normalized;
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
  const sentences = countSentences(trimmed);
  const avgWordLen = averageLength(tokens);
  const topWord = mostFrequent(tokens);
  return { words, sentences, avgWordLen, topWord };
}
