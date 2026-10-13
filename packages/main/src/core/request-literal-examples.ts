/**
 * Request-literal examples (pure; moved out of core/plan-pin-probe.ts, which re-exports it, so the
 * old-PoS run 68 repair re-pin can read them without the probe machinery: import-cycles ratchet).
 */
const ARROW = /\s*(?:->|→|=>)\s*/;
const CONNECTOR = /^\s*(?:->|→|=>|returns?|yields?|evaluates\s+to|produces?|gives?|prints?|outputs?)\s*$/i;

/** Examples the request states literally: `<input> -> <output>` in one span, or `<input>` <arrow|connector> `<output>`. */
export function requestLiteralExamples(requestText: string): Array<{ input: string; output: string }> {
  const out: Array<{ input: string; output: string }> = [];
  const spans = [...requestText.matchAll(/`([^`\n]+)`/g)].map(match => ({ text: match[1]!, start: match.index!, end: match.index! + match[0].length }));
  for (const [index, span] of spans.entries()) {
    const arrow = span.text.match(ARROW);
    if (arrow && arrow.index !== undefined && arrow.index > 0) {
      const input = span.text.slice(0, arrow.index).trim();
      const output = span.text.slice(arrow.index + arrow[0].length).trim();
      if (input && output) out.push({ input, output });
      continue;
    }
    const next = spans[index + 1];
    if (!next || next.text.match(ARROW)) continue;
    const between = requestText.slice(span.end, next.start);
    if (between.includes('\n') || !CONNECTOR.test(between)) continue;
    out.push({ input: span.text.trim(), output: next.text.trim() });
  }
  return out;
}
