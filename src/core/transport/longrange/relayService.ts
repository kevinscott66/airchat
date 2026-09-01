import type { GeographicRouter } from './geographicRouter';

export type RelayPacket = {
  id: string;
  sourceDid: string;
  targetDid: string;
  ttl: number;
  encryptedPayload: Uint8Array;
  timestamp: number;
};

export type RelayServiceDeps = {
  geographicRouter: GeographicRouter;
  getMyDid: () => Promise<string>;
  /** Отправка на следующий узел (BLE/mesh/IPFS — реализация снаружи). */
  sendToTransport?: (did: string, packet: RelayPacket) => Promise<boolean>;
};

type Queued = { packet: RelayPacket; retries: number; nextAttempt: number };

/**
 * Ретрансляция: TTL, очередь, повторы с backoff, ограничение при низком заряде.
 */
export class RelayService {
  // v4.32.153 (AUDIT P2 T9): dedup key теперь включает sourceDid. Иначе два
  // разных источника, случайно сгенерировавшие совпадающий packet.id,
  // затирали друг друга в очереди. Ключ формата `${sourceDid}:${id}`.
  private readonly pendingRelays = new Map<string, Queued>();
  // v4.32.133 (AUDIT P2): per-packet-id flush timers. Previously enqueue/
  // scheduleRetry called setTimeout(flushQueue) without storing the handle,
  // so a packet that went through N retries accumulated N pending timers,
  // each independently re-running flushQueue on every future tick. On
  // prolonged offline periods this turned into quadratic wake-ups.
  private readonly retryTimers = new Map<string, ReturnType<typeof setTimeout>>();

  /** v4.32.153 T9: составной ключ `${sourceDid}:${id}` для pendingRelays/retryTimers. */
  private keyFor(packet: RelayPacket): string {
    return `${packet.sourceDid}:${packet.id}`;
  }
  private isRelayEnabled = false;
  private readonly maxTTL = 5;
  private readonly maxRetries = 8;
  private readonly retryBaseMs = 5000;
  private batteryUnsub?: { remove?: () => void };
  private lowBattery = false;
  /**
   * v4.32.501. Разбора у службы не было вовсе. Слушатель уровня заряда,
   * подписанный в enableRelayMode, жил до конца процесса, а вместе с ним —
   * замыкание на весь экземпляр: очередь до 2048 пакетов и по таймеру повтора
   * на каждый. После выхода из аккаунта ретрансляция продолжала работать на
   * прежней личности, и заново её было уже не поднять.
   */
  private disposed = false;

  constructor(private readonly deps: RelayServiceDeps) {}

  async handleRelayPacket(packet: RelayPacket): Promise<void> {
    if (this.disposed) return;
    const myDid = await this.deps.getMyDid();
    if (packet.targetDid === myDid) {
      console.log('[Relay] Delivered to local');
      return;
    }
    // v4.32.202 (Round-32 #4): clamp peer-originated TTL on ingress.
    // Without this, a hostile peer could send ttl=9999 and the packet would
    // keep bouncing across the mesh for days. maxTTL was declared but never
    // enforced on entry.
    packet.ttl = Math.min(Math.max(0, packet.ttl | 0), this.maxTTL);
    if (packet.ttl <= 0) {
      console.log('[Relay] TTL expired');
      return;
    }
    if (this.lowBattery) {
      this.enqueue(packet, 0);
      return;
    }
    const nextHop = await this.findNextHop(packet.targetDid);
    if (nextHop) {
      const next: RelayPacket = { ...packet, ttl: packet.ttl - 1 };
      const ok = await this.sendToNode(nextHop, next);
      if (!ok) this.enqueue(packet, 0);
    } else {
      this.enqueue(packet, 0);
    }
  }

  async enableRelayMode(): Promise<void> {
    if (this.disposed) return;
    this.isRelayEnabled = true;
    void this.isRelayEnabled;
    this.setBatteryLimit(20);
  }

  /** Обработать очередь (вызывать по таймеру или после восстановления сети). */
  async flushQueue(): Promise<void> {
    if (this.disposed) return;
    const now = Date.now();
    for (const [key, q] of this.pendingRelays) {
      if (q.nextAttempt > now) continue;
      const nextHop = await this.findNextHop(q.packet.targetDid);
      if (!nextHop) continue;
      const next: RelayPacket = { ...q.packet, ttl: q.packet.ttl - 1 };
      const ok = await this.sendToNode(nextHop, next);
      if (ok) {
        this.clearRetryTimer(key);
        this.pendingRelays.delete(key);
      } else {
        this.scheduleRetry(key, q);
      }
    }
  }

  private clearRetryTimer(key: string): void {
    const t = this.retryTimers.get(key);
    if (t) {
      clearTimeout(t);
      this.retryTimers.delete(key);
    }
  }

  private armRetryTimer(key: string, delay: number): void {
    this.clearRetryTimer(key);
    const t = setTimeout(() => {
      this.retryTimers.delete(key);
      void this.flushQueue();
    }, delay);
    this.retryTimers.set(key, t);
  }

  private enqueue(packet: RelayPacket, retries: number): void {
    if (this.disposed) return;
    const key = this.keyFor(packet);
    // v4.32.202 (Round-32 #4): FIFO cap 2048 on pendingRelays. A hostile
    // mesh neighbour flooding unique packet IDs would otherwise grow the
    // Map (and arm N retry timers) without bound.
    if (!this.pendingRelays.has(key) && this.pendingRelays.size >= 2048) {
      const oldestKey = this.pendingRelays.keys().next().value as string | undefined;
      if (oldestKey) {
        this.clearRetryTimer(oldestKey);
        this.pendingRelays.delete(oldestKey);
      }
    }
    this.pendingRelays.set(key, {
      packet,
      retries,
      nextAttempt: Date.now() + this.retryBaseMs,
    });
    this.armRetryTimer(key, this.retryBaseMs);
  }

  private scheduleRetry(key: string, q: Queued): void {
    if (q.retries >= this.maxRetries) {
      this.clearRetryTimer(key);
      this.pendingRelays.delete(key);
      return;
    }
    // v4.32.154 T10: TTL декрементится при каждой неудачной ретрансляции —
    // packet aging-out наравне с maxRetries. Если TTL упал до 0/меньше,
    // дропаем пакет сразу (не ждём maxRetries). Гарантирует, что пакеты,
    // которые не могут быть доставлены, не живут в очереди неопределённо.
    const nextTtl = q.packet.ttl - 1;
    if (nextTtl <= 0) {
      this.clearRetryTimer(key);
      this.pendingRelays.delete(key);
      return;
    }
    const delay = this.retryBaseMs * Math.pow(2, Math.min(q.retries, 5));
    this.pendingRelays.set(key, {
      packet: { ...q.packet, ttl: nextTtl },
      retries: q.retries + 1,
      nextAttempt: Date.now() + delay,
    });
    this.armRetryTimer(key, delay);
  }

  private async findNextHop(targetDid: string): Promise<string | null> {
    const path = await this.deps.geographicRouter.findPath(targetDid);
    if (path.length === 0) return null;
    return path.length > 1 ? path[1].did : path[0].did;
  }

  private async sendToNode(did: string, packet: RelayPacket): Promise<boolean> {
    if (this.deps.sendToTransport) {
      return this.deps.sendToTransport(did, packet);
    }
    // No transport is wired in this build. Reporting success here would drop
    // the packet as delivered even though no bytes left the device.
    console.log('[Relay] Transport unavailable', did, packet.id);
    return false;
  }

  private setBatteryLimit(percent: number): void {
    try {
      const Battery = require('expo-battery') as {
        addBatteryLevelListener: (cb: (e: { batteryLevel: number }) => void) => { remove?: () => void };
      };
      this.batteryUnsub?.remove?.();
      this.batteryUnsub = Battery.addBatteryLevelListener(({ batteryLevel }) => {
        if (batteryLevel < percent / 100) {
          this.reduceRelayActivity();
        } else {
          this.lowBattery = false;
          void this.flushQueue();
        }
      });
    } catch {
      /* expo-battery optional */
    }
  }

  /**
   * Разбор службы: снять слушатель заряда, погасить все таймеры повторов и
   * отпустить очередь. После разбора служба инертна — новый цикл жизни
   * поднимает новый экземпляр, а не оживляет этот.
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.isRelayEnabled = false;
    this.lowBattery = false;
    for (const key of [...this.retryTimers.keys()]) this.clearRetryTimer(key);
    this.pendingRelays.clear();
    try {
      this.batteryUnsub?.remove?.();
    } catch {
      /* слушатель мог отвалиться вместе с модулем — разбор всё равно доводим */
    }
    this.batteryUnsub = undefined;
  }

  /** Только для тестов и диагностики: сколько таймеров повтора сейчас живо. */
  pendingTimerCount(): number {
    return this.retryTimers.size;
  }

  private reduceRelayActivity(): void {
    this.lowBattery = true;
    console.log('[Relay] Reducing activity due to low battery');
  }
}
