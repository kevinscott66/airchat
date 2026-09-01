import type { Helia } from '@helia/interface';
import { unixfs } from '@helia/unixfs';
import type { UnixFS } from '@helia/unixfs';
import { Platform } from 'react-native';
import { loadConfig } from '../../config';
import { log } from '../../logger';

let heliaSingleton: Promise<Helia | null> | null = null;
let batteryUnsub: (() => void) | null = null;
let batteryHooked = false;
let lowPowerOverride = false;
let ipfsKillSwitchLogged = false;

/** Avoid hanging the whole IPFS pipeline if dynamic imports / libp2p wedge on some devices. */
const HELIA_INIT_TIMEOUT_MS = 12000;

/**
 * v4.32.19: IPFS kill switch — отключён полностью на Android.
 * Причина: (1) `await import('helia')` синхронно парсит огромный стек модулей на Hermes
 * и блокирует JS-thread на ~30 секунд при старте (зафиксировано логами v4.32.18:
 * `js_thread_flush totalBlockedMs=31267`); (2) все публичные IPFS-шлюзы умерли —
 * ipfs.io возвращает 410, cloudflare-ipfs.com = network error, dweb.link = 403;
 * (3) кастомный libp2p сыпется с `Cannot read property 'digest' of undefined`
 * (multiformats `sha2-browser.js` не разрешается в metro bundler).
 * LAN transport (Wi-Fi mDNS + TCP) заменяет IPFS для offline-peer delivery.
 */
export function isIpfsEnabled(): boolean {
  // Web (браузер) — IPFS работает через gateways.
  if (Platform.OS !== 'android' && Platform.OS !== 'ios') return true;
  // Mobile — выключено до починки multiformats bundle / rework на нативный модуль.
  if (!ipfsKillSwitchLogged) {
    ipfsKillSwitchLogged = true;
    log.info('ipfs_disabled_on_mobile', { platform: Platform.OS });
  }
  return false;
}

export function setHeliaLowPowerOverride(enabled: boolean): void {
  lowPowerOverride = enabled;
  if (enabled) {
    void stopHelia();
  }
}

/**
 * In-process Helia node. On React Native, custom libp2p may fail — falls back to default `createHelia()`.
 * Connection limits and bootstrap lists follow `loadConfig()` (maxPeers, bootstrapPeers, lowPowerMode).
 */
export async function getHelia(): Promise<Helia | null> {
  // v4.32.19: kill switch — не инициализируем Helia на mobile (30s import block).
  if (!isIpfsEnabled()) return null;
  if (!heliaSingleton) {
    heliaSingleton = initHelia();
  }
  // If init never settles, don't wedge publishers — treat as unavailable.
  return await Promise.race([
    heliaSingleton,
    new Promise<Helia | null>((resolve) => {
      setTimeout(() => resolve(null), HELIA_INIT_TIMEOUT_MS + 250);
    }),
  ]);
}

async function initHelia(): Promise<Helia | null> {
  try {
    const cfg = await loadConfig();
    const low =
      lowPowerOverride || cfg.ipfs.lowPowerMode === true || (await getBatteryLowPower());
    const { createHelia } = await import('helia');

    const helia = await Promise.race([
      (async () => {
        const libp2pBundle = await tryCreateLibp2p(cfg, low);
        return libp2pBundle ? await createHelia({ libp2p: libp2pBundle }) : await createHelia();
      })(),
      new Promise<never>((_, rej) => {
        setTimeout(() => rej(new Error(`helia_init_timeout_${HELIA_INIT_TIMEOUT_MS}ms`)), HELIA_INIT_TIMEOUT_MS);
      }),
    ]);

    try {
      const cm = (helia as unknown as { libp2p?: { connectionManager?: { setMaxConnections?: (n: number) => void } } })
        .libp2p?.connectionManager;
      const max = cfg.ipfs.maxPeers ?? 20;
      cm?.setMaxConnections?.(max);
    } catch {
      /* optional API */
    }

    log.info('helia_node_ready', { lowPower: low });
    void attachBatteryListener();
    return helia;
  } catch (e) {
    log.warn('helia_init_failed', {
      err: e instanceof Error ? e.message : String(e),
    });
    return null;
  }
}

async function getBatteryLowPower(): Promise<boolean> {
  if (Platform.OS === 'web') return false;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Battery = require('expo-battery');
    const level = await Battery.getBatteryLevelAsync();
    return typeof level === 'number' && level < 0.2;
  } catch {
    return false;
  }
}

function attachBatteryListener(): void {
  if (batteryHooked || batteryUnsub || Platform.OS === 'web') return;
  batteryHooked = true;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Battery = require('expo-battery');
    const sub = Battery.addBatteryLevelListener(({ batteryLevel }: { batteryLevel: number }) => {
      if (batteryLevel < 0.2) {
        setHeliaLowPowerOverride(true);
      }
    });
    batteryUnsub = () => {
      try {
        sub?.remove?.();
      } catch {
        /* ignore */
      }
      batteryUnsub = null;
    };
  } catch {
    /* expo-battery optional */
  }
}

async function tryCreateLibp2p(
  cfg: Awaited<ReturnType<typeof loadConfig>>,
  low: boolean
): Promise<import('libp2p').Libp2p | null> {
  if (low && cfg.ipfs.bootstrapPeers.length === 0) {
    return null;
  }
  try {
    const { createLibp2p } = await import('libp2p');
    const { webSockets } = await import('@libp2p/websockets');
    const { noise } = await import('@chainsafe/libp2p-noise');
    const { yamux } = await import('@chainsafe/libp2p-yamux');
    const { bootstrap } = await import('@libp2p/bootstrap');
    const max = cfg.ipfs.maxPeers ?? 20;
    const peers = low ? cfg.ipfs.bootstrapPeers.slice(0, 3) : cfg.ipfs.bootstrapPeers;
    return createLibp2p({
      transports: [webSockets()],
      connectionEncrypters: [noise()],
      streamMuxers: [yamux()],
      connectionManager: {
        maxConnections: max,
      },
      peerDiscovery:
        peers.length > 0
          ? [
              bootstrap({
                list: peers,
              }),
            ]
          : [],
    });
  } catch (e) {
    log.info('helia_custom_libp2p_skipped', {
      err: e instanceof Error ? e.message : String(e),
    });
    return null;
  }
}

export async function getHeliaUnixfs(): Promise<UnixFS | null> {
  const h = await getHelia();
  return h ? unixfs(h) : null;
}

export async function stopHelia(): Promise<void> {
  try {
    const h = await getHelia();
    await h?.stop();
  } catch (e) {
    log.warn('helia_stop_failed', { err: e instanceof Error ? e.message : String(e) });
  } finally {
    heliaSingleton = null;
  }
}
