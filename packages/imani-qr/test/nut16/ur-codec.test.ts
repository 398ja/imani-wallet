import { describe, expect, it } from 'vitest';

import {
  bytesToString,
  createAccumulator,
  createFrameProducer,
  stringToBytes,
} from '../../src/nut16/ur-codec';

function roundTrip(input: string, maxFragmentLength = 100): string {
  const producer = createFrameProducer(stringToBytes(input), maxFragmentLength);
  const accumulator = createAccumulator();

  const fragments = producer.fragmentsLength;
  // Pull enough parts to guarantee completion under fountain coding.
  // Pulling 2x fragments handles fountain-code redundancy for any input.
  const maxParts = Math.max(fragments * 2, 5);
  for (let i = 0; i < maxParts; i += 1) {
    accumulator.receivePart(producer.nextPart());
    if (accumulator.isComplete()) break;
  }

  if (!accumulator.isComplete()) {
    throw new Error(`accumulator did not complete after ${maxParts} parts`);
  }
  expect(accumulator.isSuccess()).toBe(true);
  return bytesToString(accumulator.resultBytes());
}

describe('ur-codec', () => {
  it('round-trips a short ASCII string', () => {
    const input = 'hello world';
    expect(roundTrip(input)).toBe(input);
  });

  it('round-trips a cashuB-shaped string', () => {
    const input =
      'cashuBo2F0gaJhaUgArvSFnZG9JmFwgaNhYRhAYXNYIDJfafCO_BkX0jXKHbsHkr8K2YCAaWNGl3FmsLEjsZ-VYWNYIQODNHCBhSWP3HmwjOh7sV6vk_NXjmkJEYXuLk_jPkJzWGFkomFlWCBkYNblvqlrqVZbWxRkUkpHEQyHA0WTHm-eVQs6Jb8WdmFp-A';
    expect(roundTrip(input)).toBe(input);
  });

  it('round-trips a larger payload (1KB random ASCII)', () => {
    const charset =
      'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let s = '';
    for (let i = 0; i < 1024; i += 1) {
      s += charset[(i * 31 + 7) % charset.length];
    }
    expect(roundTrip(s)).toBe(s);
  });

  it('handles maxFragmentLength=50 with a 600-byte payload', () => {
    const input = 'X'.repeat(600);
    expect(roundTrip(input, 50)).toBe(input);
  });

  it('reports a sensible fragmentsLength', () => {
    const producer = createFrameProducer(stringToBytes('Y'.repeat(1000)), 100);
    expect(producer.fragmentsLength).toBeGreaterThan(1);
  });

  it('round-trips 100 random short payloads', () => {
    for (let i = 0; i < 100; i += 1) {
      const len = 16 + (i * 13) % 200;
      const input = Array.from({ length: len }, (_, j) =>
        String.fromCharCode(32 + ((i + j) % 95)),
      ).join('');
      expect(roundTrip(input)).toBe(input);
    }
  });
});
