import { QrTypeDetector } from './QrTypeDetector';
import { QrType, type DetectionResult, type QrTypeValue } from './types';
import { extractEmbeddedCashuToken } from './patterns';

const defaultDetector = new QrTypeDetector();

const detect = (text: string): DetectionResult<QrTypeValue> => defaultDetector.detect(text);
const isPaymentRequest = (text: string): boolean =>
  defaultDetector.validate(text, QrType.PAYMENT_REQUEST);
const isCashuToken = (text: string): boolean =>
  defaultDetector.validate(text, QrType.CASHU_TOKEN);
const isNpub = (text: string): boolean => defaultDetector.validate(text, QrType.NPUB);
const isNip05 = (text: string): boolean => defaultDetector.validate(text, QrType.NIP05);

export {
  defaultDetector,
  detect,
  extractEmbeddedCashuToken,
  isCashuToken,
  isNip05,
  isNpub,
  isPaymentRequest,
  QrTypeDetector,
  QrType
};

export type { DetectionResult, QrTypeValue };
