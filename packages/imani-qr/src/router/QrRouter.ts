import { defaultRoutes } from './defaultRoutes';
import { QrType } from '../detector/types';
import type { DetectionResult, QrTypeValue } from '../detector/types';
import { HandlerRegistry } from '../handlers/HandlerRegistry';
import type { RouteAction, RouteConfig, RouteConfigMap } from '../types/routing';

export class QrRouter {
  private routes: Map<QrTypeValue, RouteConfig>;
  private handlers: HandlerRegistry;

  constructor(routes: RouteConfigMap = {}, handlers = new HandlerRegistry()) {
    this.routes = new Map<QrTypeValue, RouteConfig>([
      ...(Object.entries(defaultRoutes) as [QrTypeValue, RouteConfig][]),
      ...(Object.entries(routes) as [QrTypeValue, RouteConfig][])
    ]);
    this.handlers = handlers;
  }

  route(detection: DetectionResult): RouteAction {
    const route = this.routes.get(detection.type) ?? this.routes.get(QrType.UNKNOWN);
    if (!route) {
      return {
        type: 'callback',
        target: 'handleUnknown',
        params: { content: detection.raw },
        detection
      };
    }

    const params = route.paramKey
      ? { [route.paramKey]: detection.normalized }
      : ({} as Record<string, unknown>);

    return {
      type: route.type,
      target: route.target,
      params,
      handler: route.execute,
      detection
    };
  }

  async parseWithHandler(detection: DetectionResult): Promise<RouteAction> {
    const action = this.route(detection);
    const handler = this.handlers.get(detection.type);
    if (!handler) {
      return action;
    }

    try {
      const { params } = await this.handlers.parse(detection.type, detection.normalized);
      action.params = params;
      return action;
    } catch {
      return action;
    }
  }

  registerHandler(type: QrTypeValue, handler: Parameters<HandlerRegistry['register']>[1]): void {
    this.handlers.register(type, handler);
  }

  registerRoute(type: QrTypeValue, config: RouteConfig): void {
    this.routes.set(type, config);
  }

  execute(action: RouteAction): void {
    if (action.handler) {
      try {
        action.handler();
        return;
      } catch {
        // fall through to default behavior
      }
    }

    switch (action.type) {
      case 'navigate':
        if (typeof window !== 'undefined' && window.location) {
          const url = this.buildUrl(action.target, action.params);
          window.location.href = url;
        }
        break;
      case 'modal':
        if (typeof window !== 'undefined') {
          const event = new CustomEvent('qr:modal', { detail: action });
          window.dispatchEvent(event);
        }
        break;
      case 'callback':
      default:
        // no-op; callback handled above
        break;
    }
  }

  private buildUrl(target: string, params: Record<string, unknown>): string {
    const hasQuery = target.includes('?');
    const searchParams = new URLSearchParams(hasQuery ? target.split('?')[1] : '');
    Object.entries(params).forEach(([key, value]) => {
      if (value !== undefined) {
        searchParams.set(key, String(value));
      }
    });
    const base = hasQuery ? target.split('?')[0] : target;
    const query = searchParams.toString();
    return query ? `${base}?${query}` : base;
  }
}
