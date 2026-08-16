import type { QrTypeValue } from '../detector/types';
import type { HandlerMap, QrHandler } from '../types/handlers';

export class HandlerRegistry {
  private handlers: Map<QrTypeValue, QrHandler<unknown>>;

  constructor(initialHandlers: HandlerMap = {}) {
    this.handlers = new Map(Object.entries(initialHandlers) as [QrTypeValue, QrHandler<unknown>][]);
  }

  register(type: QrTypeValue, handler: QrHandler<unknown>): void {
    this.handlers.set(type, handler);
  }

  get(type: QrTypeValue): QrHandler<unknown> | undefined {
    return this.handlers.get(type);
  }

  async parse<TParsed = unknown>(type: QrTypeValue, text: string): Promise<{
    parsed: TParsed;
    params: Record<string, unknown>;
  }> {
    const handler = this.handlers.get(type) as QrHandler<TParsed> | undefined;
    if (!handler) {
      throw new Error(`No handler registered for type ${String(type)}`);
    }

    if (!handler.validate(text)) {
      throw new Error('Content failed validation');
    }

    const parsed = await handler.parse(text);
    return {
      parsed,
      params: handler.getParams(parsed)
    };
  }
}
