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

/**
 * Итог отправки. «Отправлено» — только когда нативный `sendMessageTo`
 * вернулся без ошибки; локальная очередь или известный узел доставку не
 * доказывают.
 */
export type WiFiMeshSendOutcome =
  | { ok: true }
  | {
      ok: false;
      reason: 'inactive' | 'module_unavailable' | 'no_address' | 'native_failed' | 'stopped';
    };

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
  private isActive = false;
  private p2pInitialized = false;
  private p2pGroupCreated = false;
  private p2pDiscovering = false;
  /**
   * Поколение цикла жизни. `stop()` его увеличивает, и всё, что было начато
   * до остановки (скан, подъём группы), по возвращении из await видит чужое
   * поколение и не пишет в уже очищенное состояние: иначе узлы прошлой
   * личности всплыли бы в следующем цикле.
   */
  private epoch = 0;
  private readonly isSupported = isWifiDirectSupported;
  private onDeviceFoundCb?: (device: { did: string; transports: string[] }) => void;

  onDeviceFound(cb: (device: { did: string; transports: string[] }) => void): void {
    this.onDeviceFoundCb = cb;
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

    const epoch = this.epoch;
    const P2p = await loadWifiP2p();
    if (P2p) {
      try {
        if (!this.p2pInitialized) {
          await P2p.initialize();
          this.p2pInitialized = true;
        }
        await P2p.createGroup();
        // Группа создана в эфире — помечаем сразу, даже если остановка уже
        // случилась: removeGroup в stop() обязан её снять.
        this.p2pGroupCreated = true;
        const info = await P2p.getGroupInfo();
        if (epoch !== this.epoch) {
          // Пока поднимали, транспорт остановили — группа осиротела.
          await this.removeGroupQuietly(P2p);
          return false;
        }
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

    this.isActive = false;
    return false;
  }

  async scanAndConnect(): Promise<void> {
    const epoch = this.epoch;
    const P2p = await loadWifiP2p();
    if (epoch !== this.epoch) return;
    /** Кому уже сообщили в этом вызове — чтобы свежий узел не пришёл дважды. */
    const notified = new Set<string>();
    if (P2p) {
      try {
        if (!this.p2pInitialized) {
          await P2p.initialize();
          this.p2pInitialized = true;
        }
        await P2p.startDiscoveringPeers();
        this.p2pDiscovering = true;
        const peers = await P2p.getAvailablePeers();
        if (epoch !== this.epoch) {
          // Остановили посреди скана: обнаружение, запущенное этим вызовом,
          // уже никому не нужно, а найденные узлы принадлежат прошлому циклу.
          await this.stopDiscoveryQuietly(P2p);
          return;
        }
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
          notified.add(syntheticDid);
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
    for (const peer of [...this.nodes.values()]) {
      if (notified.has(peer.did)) continue;
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
    return (await this.sendDetailed(data, targetDid)).ok;
  }

  /**
   * Отправка с разобранным итогом. Успех — только ответ нативного
   * `sendMessageTo` без исключения. Раньше после ошибки нативной отправки
   * код проваливался в «групповой» возврат и отвечал true, если группа
   * поднята и узел известен, — отправитель считал пакет ушедшим, хотя в
   * эфир ничего не вышло.
   */
  async sendDetailed(data: Uint8Array, targetDid: string): Promise<WiFiMeshSendOutcome> {
    if (!this.isActive) return { ok: false, reason: 'inactive' };
    const epoch = this.epoch;
    const P2p = await loadWifiP2p();
    if (!P2p) return { ok: false, reason: 'module_unavailable' };
    const addr = this.resolveP2pDeviceAddress(targetDid);
    if (!addr) {
      log.debug('[WiFiMesh] no P2P address for target', { targetDid: targetDid.slice(0, 24) });
      return { ok: false, reason: 'no_address' };
    }
    try {
      if (!this.p2pInitialized) {
        await P2p.initialize();
        this.p2pInitialized = true;
      }
      await P2p.connect(addr);
      if (epoch !== this.epoch) return { ok: false, reason: 'stopped' };
      const b64 = Buffer.from(data).toString('base64');
      await P2p.sendMessageTo(b64, addr);
      log.info('[WiFiMesh] sendMessageTo ok', { targetDid: targetDid.slice(0, 24), len: data.length });
      return { ok: true };
    } catch (e) {
      log.warn('[WiFiMesh] P2P send failed', { err: e instanceof Error ? e.message : String(e) });
      return { ok: false, reason: 'native_failed' };
    }
  }

  /**
   * Остановить транспорт: снять обнаружение и группу в эфире, забыть узлы и
   * обработчик. Идемпотентна: повторный вызов не трогает нативный модуль.
   * Ошибки нативной остановки только логируются — разбор обязан доехать до
   * конца, иначе следующий цикл получит полуразобранный синглтон.
   */
  async stop(): Promise<void> {
    this.epoch += 1;
    this.isActive = false;
    this.nodes.clear();
    this.onDeviceFoundCb = undefined;
    if (!this.p2pDiscovering && !this.p2pGroupCreated) return;
    const P2p = await loadWifiP2p();
    if (!P2p) {
      this.p2pDiscovering = false;
      this.p2pGroupCreated = false;
      return;
    }
    await this.releaseNative(P2p);
  }

  /** Снять нативные обнаружение и группу, если они подняты. Не бросает. */
  private async releaseNative(P2p: WifiP2pModule): Promise<void> {
    await this.stopDiscoveryQuietly(P2p);
    await this.removeGroupQuietly(P2p);
  }

  private async stopDiscoveryQuietly(P2p: WifiP2pModule): Promise<void> {
    if (this.p2pDiscovering) {
      this.p2pDiscovering = false;
      try {
        await P2p.stopDiscoveringPeers();
      } catch (e) {
        log.warn('[WiFiMesh] stopDiscoveringPeers failed', {
          err: e instanceof Error ? e.message : String(e),
        });
      }
    }
  }

  private async removeGroupQuietly(P2p: WifiP2pModule): Promise<void> {
    if (this.p2pGroupCreated) {
      this.p2pGroupCreated = false;
      try {
        await P2p.removeGroup();
      } catch (e) {
        log.warn('[WiFiMesh] removeGroup failed', {
          err: e instanceof Error ? e.message : String(e),
        });
      }
    }
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
    return this.nodes.has(targetDid);
  }

  getPeers(): WiFiMeshNode[] {
    return [...this.nodes.values()];
  }
}
