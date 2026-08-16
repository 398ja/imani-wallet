import type { DetectionResult, QrTypeValue } from '../detector/types';

export type RouteActionType = 'navigate' | 'modal' | 'callback';

export interface RouteAction {
  type: RouteActionType;
  target: string;
  params: Record<string, unknown>;
  handler?: () => void;
  detection?: DetectionResult;
}

export interface RouteConfig {
  type: RouteActionType;
  target: string;
  paramKey?: string;
  execute?: () => void;
}

export type RouteConfigMap = Partial<Record<QrTypeValue, RouteConfig>>;
