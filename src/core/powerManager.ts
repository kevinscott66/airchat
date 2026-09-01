import { Platform } from 'react-native';
import { log } from './logger';

let lastActivity = Date.now();
let lowPowerMode = false;
let batteryUnsub: (() => void) | null = null;
let batteryStateUnsub: (() => void) | null = null;

let batteryLevel = 1;
let isCharging = false;

export function getPowerStatus(): {
  batteryLevel: number;
  isCharging: boolean;
} {
  return { batteryLevel, isCharging };
}

export function recordUserActivity(): void {
  lastActivity = Date.now();
}

async function syncPowerFromBattery(): Promise<void> {
  if (Platform.OS === 'web') return;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Battery = require('expo-battery');
    const ps = await Battery.getPowerStateAsync();
    if (ps.batteryLevel >= 0) batteryLevel = ps.batteryLevel;
    const BS = Battery.BatteryState;
    isCharging = ps.batteryState === BS.CHARGING || ps.batteryState === BS.FULL;
    const next = batteryLevel < 0.2;
    if (next !== lowPowerMode) {
      lowPowerMode = next;
      log.info('power_mode_update', { lowPowerMode });
    }
  } catch {
    /* ignore */
  }
}

export function initPowerManager(): void {
  if (Platform.OS === 'web') return;
  void syncPowerFromBattery();
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Battery = require('expo-battery');
    const sub = Battery.addBatteryLevelListener(() => { void syncPowerFromBattery(); });
    const subState = Battery.addBatteryStateListener(() => { void syncPowerFromBattery(); });
    batteryUnsub = () => { try { sub?.remove?.(); } catch { /* ignore */ } };
    batteryStateUnsub = () => { try { subState?.remove?.(); } catch { /* ignore */ } };
  } catch {
    /* optional */
  }
}

export function disposePowerManager(): void {
  batteryUnsub?.();
  batteryUnsub = null;
  batteryStateUnsub?.();
  batteryStateUnsub = null;
  void lastActivity;
}
