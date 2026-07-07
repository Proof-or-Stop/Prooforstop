export default function analyze(text) {
  if (typeof text !== "string") {
    throw new Error("Input must be a string");
  }

  if (text.trim() === "") {
    return { words: 0, sentences: 0, avgWordLen: 0, topWord: "" };
  }

  const tokens = text
    .trim()
    .split(/\s+/)
    .map((token) => token.replace(/[^\p{L}]/gu, ""))
    .filter(Boolean);

  const counts = new Map();
  let topWord = "";
  let topCount = 0;
  let totalLength = 0;

  for (const token of tokens) {
    totalLength += Array.from(token).length;

    const normalized = token.toLowerCase();
    const count = (counts.get(normalized) ?? 0) + 1;
    counts.set(normalized, count);

    if (count > topCount) {
      topWord = normalized;
      topCount = count;
    }
  }

  const sentenceRuns = text.match(/[.!?]+/g);
  const words = tokens.length;
  const sentences = sentenceRuns ? sentenceRuns.length : 1;
  const avgWordLen = words === 0 ? 0 : Math.round((totalLength / words) * 10) / 10;

  return { words, sentences, avgWordLen, topWord };
}
