import { Buffer } from 'buffer';
import { Platform } from 'react-native';

import { log } from '../../logger';

/** Android 5.0+ — Wi‑Fi P2P API; реальная группа через `react-native-wifi-p2p`. */
export const isWifiDirectSupported =
  Platform.OS === 'android' &&
  typeof Platform.Version === 'number' &&
  Platform.Version >= 21;

let meshSingleton: WiFiMeshTransport | null = null;

export function getWiFiMeshTransport(): WiFiMeshTransport {
  if (!meshSingleton) meshSingleton = new WiFiMeshTransport();
  return meshSingleton;
}

export type WiFiMeshNode = {
  did: string;
  /** P2P MAC (Android), если известен */
  deviceAddress?: string;
  ip: string;
  port: number;
  ssid: string;
  lastSeen: number;
  hops: number;
};

type MeshPacket = { targetDid: string; payload: Uint8Array };

type WifiP2pModule = typeof import('react-native-wifi-p2p');

async function loadWifiP2p(): Promise<WifiP2pModule | null> {
  if (Platform.OS !== 'android') return null;
  try {
    return await import('react-native-wifi-p2p');
  } catch (e) {
    log.warn('wifi_p2p_module_unavailable', {
      err: e instanceof Error ? e.message : String(e),
    });
    return null;
  }
}

/**
 * Wi‑Fi Direct / локальная mesh: нативный P2P (Android) + внутренняя таблица узлов по `did`.
 */
export class WiFiMeshTransport {
  private readonly nodes = new Map<string, WiFiMeshNode>();
  private readonly rxByDid = new Map<string, MeshPacket[]>();
  private isApMode = false;
  private isActive = false;
  private p2pInitialized = false;
  private p2pGroupCreated = false;
  private readonly isSupported = isWifiDirectSupported;
  private onDeviceFoundCb?: (device: { did: string; transports: string[] }) => void;
  /** Общая шина для эмуляции нескольких экземпляров в одном процессе (тесты). */
  private static sharedBus: MeshPacket[] | null = null;

  static attachSharedBus(bus: MeshPacket[]): void {
    WiFiMeshTransport.sharedBus = bus;
  }

  static detachSharedBus(): void {
    WiFiMeshTransport.sharedBus = null;
  }

  onDeviceFound(cb: (device: { did: string; transports: string[] }) => void): void {
    this.onDeviceFoundCb = cb;
  }

  /**
   * v4.32.501: снять обработчик найденных устройств. Транспорт — синглтон на
   * процесс, поэтому обработчик, поставленный прошлым циклом жизни long-range,
   * иначе продолжал кормить уже разобранную синхронизацию.
   */
  clearDeviceFoundHandler(): void {
    this.onDeviceFoundCb = undefined;
  }

  async startAccessPoint(): Promise<boolean> {
    if (!this.isSupported) {
      log.info('[WiFiMesh] Not supported on this device');
      return false;
    }
    if (Platform.OS !== 'android' && !__DEV__) {
      log.info('[WiFiMesh] Wi‑Fi Direct is Android-first');
      return false;
    }

    const P2p = await loadWifiP2p();
    if (P2p) {
      try {
        await P2p.initialize();
        this.p2pInitialized = true;
        await P2p.createGroup();
        this.p2pGroupCreated = true;
        const info = await P2p.getGroupInfo();
        this.isApMode = true;
        this.isActive = true;
        log.info('[WiFiMesh] P2P group owner active', {
          networkName: info.networkName,
          passphraseLen: info.passphrase?.length ?? 0,
        });
        return true;
      } catch (error) {
        log.warn('[WiFiMesh] P2P createGroup failed', {
          err: error instanceof Error ? error.message : String(error),
        });
      }
    } else {
      log.warn('[WiFiMesh] react-native-wifi-p2p unavailable');
    }

    /** Только для unit-тестов в одном процессе — не маскируем отсутствие P2P как «успех». */
    if (WiFiMeshTransport.sharedBus) {
      this.isApMode = true;
      this.isActive = true;
      log.info('[WiFiMesh] active (in-process test bus only)');
      return true;
    }

    this.isApMode = false;
    this.isActive = false;
    return false;
  }

  async scanAndConnect(): Promise<void> {
    const P2p = await loadWifiP2p();
    if (P2p) {
      try {
        if (!this.p2pInitialized) {
          await P2p.initialize();
          this.p2pInitialized = true;
        }
        await P2p.startDiscoveringPeers();
        const peers = await P2p.getAvailablePeers();
        const list = peers.devices ?? [];
        log.info('[WiFiMesh] P2P scan', { peerCount: list.length });
        for (const d of list) {
          const syntheticDid = `did:p2p:${d.deviceAddress}`;
          this.registerPeer({
            did: syntheticDid,
            deviceAddress: d.deviceAddress,
            ip: '',
            port: 0,
            ssid: d.deviceName ?? 'p2p-peer',
            lastSeen: Date.now(),
            hops: 1,
          });
          this.onDeviceFoundCb?.({
            did: syntheticDid,
            transports: ['wifi', 'wifi-direct'],
          });
        }
      } catch (e) {
        log.warn('[WiFiMesh] P2P scan failed', { err: e instanceof Error ? e.message : String(e) });
      }
    }

    log.debug('[WiFiMesh] notify registered peers', { count: this.nodes.size });
    for (const peer of this.nodes.values()) {
      this.onDeviceFoundCb?.({
        did: peer.did,
        transports: ['wifi'],
      });
    }
  }

  registerPeer(node: WiFiMeshNode): void {
    // v4.32.201 (Round-31 #4): cap nodes map at 128 with FIFO eviction by
    // lastSeen. Without a cap, repeated P2P scan results from a hostile
    // environment could grow the map unboundedly.
    if (!this.nodes.has(node.did) && this.nodes.size >= 128) {
      let oldestDid: string | null = null;
      let oldestSeen = Infinity;
      for (const [d, n] of this.nodes) {
        if (n.lastSeen < oldestSeen) { oldestSeen = n.lastSeen; oldestDid = d; }
      }
      if (oldestDid) this.nodes.delete(oldestDid);
    }
    this.nodes.set(node.did, { ...node, lastSeen: Date.now() });
  }

  async send(data: Uint8Array, targetDid: string): Promise<boolean> {
    if (!this.isActive) return false;
    const pkt: MeshPacket = { targetDid, payload: new Uint8Array(data) };
    const q = this.rxByDid.get(targetDid);
    if (q) q.push(pkt);
    if (WiFiMeshTransport.sharedBus) WiFiMeshTransport.sharedBus.push(pkt);

    const P2p = await loadWifiP2p();
    const addr = this.resolveP2pDeviceAddress(targetDid);
    if (P2p && addr) {
        try {
          if (!this.p2pInitialized) {
            await P2p.initialize();
            this.p2pInitialized = true;
          }
          await P2p.connect(addr);
          const b64 = Buffer.from(data).toString('base64');
          await P2p.sendMessageTo(b64, addr);
          log.info('[WiFiMesh] sendMessageTo ok', { targetDid: targetDid.slice(0, 24), len: data.length });
          return true;
        } catch (e) {
          log.warn('[WiFiMesh] P2P send failed', { err: e instanceof Error ? e.message : String(e) });
        }
    }

    log.debug('[WiFiMesh] local queue only (no P2P send)', {
      targetDid,
      len: data.length,
      p2pGroup: this.p2pGroupCreated,
    });
    return this.isApMode && (this.nodes.has(targetDid) || WiFiMeshTransport.sharedBus !== null);
  }

  /** did:p2p:<mac> или узел из скана с deviceAddress */
  private resolveP2pDeviceAddress(targetDid: string): string | null {
    if (targetDid.startsWith('did:p2p:')) {
      return targetDid.slice('did:p2p:'.length);
    }
    const n = this.nodes.get(targetDid);
    return n?.deviceAddress ?? null;
  }

  async canReach(targetDid: string): Promise<boolean> {
    if (!this.isActive) return false;
    if (WiFiMeshTransport.sharedBus !== null) return true;
    if (this.nodes.has(targetDid)) return true;
    if (targetDid.startsWith('did:p2p:')) {
      return this.nodes.has(targetDid);
    }
    return false;
  }

  receiveFor(localDid: string): MeshPacket | undefined {
    const q = this.rxByDid.get(localDid);
    return q?.shift();
  }

  getPeers(): WiFiMeshNode[] {
    return [...this.nodes.values()];
  }
}
