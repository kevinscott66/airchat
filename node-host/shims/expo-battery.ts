/**
 * Node-замена `expo-battery`.
 *
 * Машины, на которых поднимают headless-ядро, батареи обычно не имеют, а
 * узнать про неё из Node нечем — нативная часть expo-battery читает
 * BatteryManager и IOKit. Поэтому отвечаем так, как выглядит машина в
 * розетке: заряд полный, идёт питание, режим экономии выключен.
 *
 * Это не безобидная выдумка, и стоит понимать, на что она влияет.
 * `powerManager` по этим числам решает, включать ли бережный режим, а
 * `heliaNode` и `relayService` — насколько часто ходить в сеть. Ответ «полный
 * заряд» означает «работай в полную силу», и для процесса на сервере это
 * верно. На ноутбуке от батареи ядро не станет экономить — знать об этом
 * надо, но лучше так, чем выдуманный низкий заряд, который без причины
 * придушил бы доставку.
 */
export const BatteryState = { UNKNOWN: 0, UNPLUGGED: 1, CHARGING: 2, FULL: 3 } as const;

export type PowerState = {
  batteryLevel: number;
  batteryState: number;
  lowPowerMode: boolean;
};

export async function getBatteryLevelAsync(): Promise<number> {
  return 1;
}

export async function getBatteryStateAsync(): Promise<number> {
  return BatteryState.FULL;
}

export async function isLowPowerModeEnabledAsync(): Promise<boolean> {
  return false;
}

export async function getPowerStateAsync(): Promise<PowerState> {
  return { batteryLevel: 1, batteryState: BatteryState.FULL, lowPowerMode: false };
}

/** Заряд не меняется — сообщать не о чем; подписка снимается как обычно. */
export function addBatteryLevelListener(): { remove: () => void } {
  return { remove: () => undefined };
}

export function addBatteryStateListener(): { remove: () => void } {
  return { remove: () => undefined };
}

export function addLowPowerModeListener(): { remove: () => void } {
  return { remove: () => undefined };
}

export default {
  BatteryState,
  getBatteryLevelAsync,
  getBatteryStateAsync,
  isLowPowerModeEnabledAsync,
  getPowerStateAsync,
  addBatteryLevelListener,
  addBatteryStateListener,
  addLowPowerModeListener,
};
