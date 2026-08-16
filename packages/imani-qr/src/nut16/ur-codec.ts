import { UR, UREncoder, URDecoder } from '@gandlaf21/bc-ur';
import { Buffer } from 'buffer';

import { DEFAULT_MAX_FRAGMENT_LENGTH } from './types';

export interface UrFrameProducer {
  nextPart(): string;
  fragmentsLength: number;
}

export function createFrameProducer(
  bytes: Uint8Array,
  maxFragmentLength: number = DEFAULT_MAX_FRAGMENT_LENGTH,
): UrFrameProducer {
  const buffer = Buffer.from(bytes);
  const ur = UR.fromBuffer(buffer);
  const encoder = new UREncoder(ur, maxFragmentLength);
  return {
    nextPart: () => encoder.nextPart(),
    get fragmentsLength() {
      return encoder.fragmentsLength;
    },
  };
}

export interface UrAccumulator {
  receivePart(part: string): boolean;
  isComplete(): boolean;
  isSuccess(): boolean;
  isError(): boolean;
  resultError(): string;
  resultBytes(): Uint8Array;
  expectedPartCount(): number;
  receivedPartIndexes(): number[];
  estimatedPercentComplete(): number;
}

export function createAccumulator(): UrAccumulator {
  const decoder = new URDecoder();
  return {
    receivePart: (part) => decoder.receivePart(part),
    isComplete: () => decoder.isComplete(),
    isSuccess: () => decoder.isSuccess(),
    isError: () => decoder.isError(),
    resultError: () => decoder.resultError(),
    resultBytes: () => {
      const ur = decoder.resultUR();
      const cborBuffer = ur.decodeCBOR();
      return new Uint8Array(cborBuffer);
    },
    expectedPartCount: () => decoder.expectedPartCount(),
    receivedPartIndexes: () => decoder.receivedPartIndexes(),
    estimatedPercentComplete: () => decoder.estimatedPercentComplete(),
  };
}

export function bytesToString(bytes: Uint8Array): string {
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

export function stringToBytes(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}
