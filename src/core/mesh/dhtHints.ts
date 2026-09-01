/** Опциональные подсказки маршрута в DHT / профиле (фаза 6). */

export type RouteHintRecord = {
  targetDid: string;
  hint: string;
  expiresAt: number;
};

export async function publishRouteHint(_record: RouteHintRecord): Promise<void> {
  return Promise.resolve();
}

export async function resolveRouteHints(_targetDid: string): Promise<RouteHintRecord[]> {
  return [];
}
