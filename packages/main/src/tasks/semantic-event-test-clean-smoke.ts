/**
 * Advisory semantic_analysis_unavailable events must never dirty canonical
 * story metadata on the way into TEST or DONE. Those transitions capture a
 * clean baseline of process-events.jsonl and refuse any pre-existing change,
 * so an event appended by the scope gate just before the capture made every
 * non-TS/JS story (Go, Rust, Python...) unable to reach TEST, and each retry
 * appended another copy (observed on the abs Go benchmark, run 9).
 */
import assert from 'node:assert/strict';
import { emitSemanticDegradationEvent } from '../handlers/scope-contract.js';
import { emitsSemanticDegradationAt } from '../handlers/phase-gates.js';

function fakeStore() {
  const events: any[] = [];
  return {
    events,
    appendProcessEvent: (_id: string, ev: any) => { events.push({ ...ev, timestamp: new Date().toISOString() }); },
    readProcessEvents: (_id: string) => events,
  } as any;
}

const pack = { semanticAnalysisUnavailable: ['go'] };

// Across calls: an identical event already recorded is not appended again.
const store = fakeStore();
emitSemanticDegradationEvent(store, 'B-x', pack);
emitSemanticDegradationEvent(store, 'B-x', pack);
assert.equal(store.events.length, 1, 'an identical degradation event is recorded once per story, not once per transition');

// A different language set is new information and is recorded.
emitSemanticDegradationEvent(store, 'B-x', { semanticAnalysisUnavailable: ['go', 'rs'] });
assert.equal(store.events.length, 2, 'a changed language set is recorded');

// Transactional transitions never emit: REVIEW does, TEST and DONE do not.
assert.equal(emitsSemanticDegradationAt('REVIEW'), true, 'REVIEW entry still surfaces the degradation');
assert.equal(emitsSemanticDegradationAt('TEST'), false, 'TEST entry must not append before its clean metadata capture');
assert.equal(emitsSemanticDegradationAt('DONE'), false, 'DONE entry must not append before its clean metadata capture');

console.log('semantic-event-test-clean-smoke: PASS');
