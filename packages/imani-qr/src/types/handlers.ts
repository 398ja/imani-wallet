import type { QrTypeValue } from '../detector/types';

export interface QrHandler<TParsed = unknown> {
  validate(text: string): boolean;
  parse(text: string): Promise<TParsed>;
  getParams(parsed: TParsed): Record<string, unknown>;
}

export type HandlerMap = Partial<Record<QrTypeValue, QrHandler<unknown>>>;
