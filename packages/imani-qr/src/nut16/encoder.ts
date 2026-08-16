import {
  createFrameProducer,
  stringToBytes,
  type UrFrameProducer,
} from './ur-codec';
import {
  DEFAULT_FRAME_INTERVAL_MS,
  DEFAULT_MAX_FRAGMENT_LENGTH,
  Nut16EncodeError,
  STATIC_BYTE_GUARD,
  type Nut16EncodeOptions,
  type Nut16EncodeResult,
  type Nut16FrameIterator,
} from './types';

const CASHU_B_PATTERN = /^cashuB[A-Za-z0-9_-]+$/;

export function encode(
  cashuBToken: string,
  options: Nut16EncodeOptions = {},
): Nut16EncodeResult {
  if (typeof cashuBToken !== 'string' || cashuBToken.trim().length === 0) {
    throw new Nut16EncodeError(
      'EMPTY_INPUT',
      'cashuB token must be a non-empty string',
    );
  }
  if (!CASHU_B_PATTERN.test(cashuBToken)) {
    throw new Nut16EncodeError(
      'NOT_CASHU_V4',
      'input does not look like a cashuB-prefixed Cashu V4 token',
    );
  }

  const frameIntervalMs = options.frameIntervalMs ?? DEFAULT_FRAME_INTERVAL_MS;
  const maxFragmentLength =
    options.maxFragmentLength ?? DEFAULT_MAX_FRAGMENT_LENGTH;
  const forceAnimated = options.forceAnimated ?? false;

  const bytes = stringToBytes(cashuBToken);
  const fitsStatic = bytes.length <= STATIC_BYTE_GUARD;

  if (!forceAnimated && fitsStatic) {
    return {
      mode: 'static',
      staticContent: cashuBToken,
      frameIntervalMs,
    };
  }

  return makeAnimated(bytes, maxFragmentLength, frameIntervalMs);
}

function makeAnimated(
  bytes: Uint8Array,
  maxFragmentLength: number,
  frameIntervalMs: number,
): Extract<Nut16EncodeResult, { mode: 'animated' }> {
  let producer: UrFrameProducer = createFrameProducer(bytes, maxFragmentLength);
  const estimatedFrameCount = producer.fragmentsLength;
  const iterator: Nut16FrameIterator = {
    next: () => ({ value: producer.nextPart(), done: false }),
    reset: () => {
      producer = createFrameProducer(bytes, maxFragmentLength);
    },
  };
  return {
    mode: 'animated',
    frames: iterator,
    frameIntervalMs,
    estimatedFrameCount,
  };
}
