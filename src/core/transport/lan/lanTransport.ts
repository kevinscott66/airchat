import { Platform } from 'react-native';

import { log } from '../../logger';
import { LanFrameAccumulator, encodeLanFrame } from './lanFrames';
import { InboundSocketRegistry, LAN_INBOUND_SWEEP_MS } from './lanInbound';
import { tcpSend, type TcpModule } from './lanSend';

export type LanPeer = {
  did: string;
  host: string;
  port: number;
  lastSeen: number;
};

const SERVICE_TYPE = 'airchat';
const PEER_TTL_MS = 120_000;
const SCAN_REFRESH_MS = 45_000;
/**
 * v4.32.67: debounce для onPeerDiscovered — после TTL пира (PEER_TTL_MS=120s)
 * mDNS-resolve тут же переотправит тот же `resolved` event (runScan каждые 45с),
 * но мы не хотим спамить feed-flush при каждом rediscover-е уже виденного пира.
 * Триггерим колбэк только если пир был «unseen» (нет в map ИЛИ lastSeen старше этого окна).
 */
const PEER_DISCOVERY_DEBOUNCE_MS = 30_000;

function loadTcp(): TcpModule {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const m = require('react-native-tcp-socket') as { default?: TcpModule } & TcpModule;
  return (m.default ?? m) as TcpModule;
}

type ZeroconfInstance = {
  publishService: (
    type: string,
    protocol: string,
    domain: string,
    name: string,
    port: number,
    txt?: Record<string, string>,
    implType?: string
  ) => void;
  scan: (type: string, protocol: string, domain: string, implType?: string) => void;
  stop: (implType?: string) => void;
  unpublishService: (name: string, implType?: string) => void;
  removeDeviceListeners: () => void;
  on: (ev: string, cb: (svc: Record<string, unknown>) => void) => void;
};

function loadZeroconfModule(): {
  default: new () => ZeroconfInstance;
  ImplType: { NSD: string; DNSSD: string };
} {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('react-native-zeroconf');
}

// v4.32.203 (Round-33 #3): strict IPv4 / IPv6 validation on peer-originated
// mDNS TXT addresses. Without this, a hostile LAN device could advertise
// addresses like "evil.example.com\rInjected: 1" and the raw string would
// land in TcpSocket.createConnection({ host }).
const IPV4_RE = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
const IPV6_RE = /^[0-9a-fA-F:]{2,45}$/;
function isValidHost(h: string | undefined): h is string {
  return typeof h === 'string' && h.length <= 64 && (IPV4_RE.test(h) || IPV6_RE.test(h));
}

function pickHost(svc: {
  host?: string;
  addresses?: string[];
}): string | null {
  const addrs = svc.addresses ?? [];
  const v4 = addrs.find((a) => isValidHost(a) && !a.includes(':'));
  if (v4) return v4;
  if (isValidHost(svc.host) && /^\d+\.\d+\.\d+\.\d+$/.test(svc.host)) return svc.host;
  const any = addrs.find(isValidHost);
  if (any) return any;
  if (isValidHost(svc.host)) return svc.host;
  return null;
}

/**
 * Локальная сеть (тот же Wi‑Fi роутер): mDNS `_airchat._tcp` + TCP с кадрами ACPT.
 * Не использует интернет; требует dev build с нативными модулями.
 */
export class LanTransport {
  private myDid = '';
  private port = 9000;
  private zeroconf: ZeroconfInstance | null = null;
  private publishName = '';
  private server: ReturnType<TcpModule['createServer']> | null = null;
  private peers = new Map<string, LanPeer>();
  private onFrame?: (senderDid: string, payload: Uint8Array) => void;
  /** v4.32.67: колбэк при discovery нового/освежённого пира — для flush-on-reconnect. */
  private onPeerDiscovered?: (peerDid: string) => void;
  private scanTimer: ReturnType<typeof setInterval> | null = null;
  private ttlTimer: ReturnType<typeof setInterval> | null = null;
  private inboundTimer: ReturnType<typeof setInterval> | null = null;
  private readonly inbound = new InboundSocketRegistry();
  private active = false;

  isActive(): boolean {
    return this.active;
  }

  getPeers(): LanPeer[] {
    return [...this.peers.values()];
  }

  canReach(targetDid: string): boolean {
    const p = this.peers.get(targetDid);
    if (!p) return false;
    return Date.now() - p.lastSeen < PEER_TTL_MS;
  }

  async send(data: Uint8Array, targetDid: string): Promise<boolean> {
    if (!this.active || !this.myDid) return false;
    const peer = this.peers.get(targetDid);
    if (!peer || Date.now() - peer.lastSeen > PEER_TTL_MS) return false;
    const frame = encodeLanFrame(this.myDid, data);
    return tcpSend(loadTcp(), peer.host, peer.port, frame);
  }

  start(opts: {
    myDid: string;
    port: number;
    onFrame: (senderDid: string, payload: Uint8Array) => void;
    /** v4.32.67: вызывается когда в LAN появился новый peer (или старый после TTL-паузы).
     *  Coordinator использует для flush feed-queue + outbox, нацеленных на этот DID. */
    onPeerDiscovered?: (peerDid: string) => void;
  }): void {
    if (Platform.OS === 'web') {
      log.info('lan_skip_web');
      return;
    }
    this.stop();
    this.myDid = opts.myDid;
    this.port = opts.port;
    this.onFrame = opts.onFrame;
    this.onPeerDiscovered = opts.onPeerDiscovered;

    try {
      const TcpSocket = loadTcp();
      this.server = TcpSocket.createServer((socket) => {
        const acc = new LanFrameAccumulator();
        // v4.32.338: соединение берётся на учёт — иначе молчащие сокеты чужого
        // устройства копятся вместе со своими накопителями кадров.
        const socketId = this.inbound.add(socket, Date.now());
        socket.on('data', (chunk: unknown) => {
          if (chunk == null) return;
          let u8: Uint8Array;
          if (chunk instanceof Uint8Array) u8 = chunk;
          else if (typeof Buffer !== 'undefined' && Buffer.isBuffer(chunk)) {
            u8 = new Uint8Array(chunk);
          } else if (chunk instanceof ArrayBuffer) {
            u8 = new Uint8Array(chunk);
          } else {
            return;
          }
          this.inbound.touch(socketId, Date.now());
          const frames = acc.append(u8);
          for (const f of frames) {
            this.onFrame?.(f.senderDid, f.payload);
          }
        });
        socket.on('close', () => this.inbound.forget(socketId));
        socket.on('end', () => this.inbound.forget(socketId));
        socket.on('error', () => {
          this.inbound.close(socketId);
        });
      });
      this.server.listen({ port: this.port, host: '0.0.0.0', reuseAddress: true }, () => {
        log.info('lan_tcp_listening', { port: this.port });
      });
      this.server.on?.('error', (e) => {
        log.warn('lan_tcp_server_err', { err: e?.message ?? String(e) });
      });
      this.inboundTimer = setInterval(() => {
        const closed = this.inbound.sweep(Date.now());
        if (closed > 0) log.info('lan_inbound_idle_closed', { closed, open: this.inbound.size });
      }, LAN_INBOUND_SWEEP_MS);
    } catch (e) {
      log.warn('lan_tcp_server_failed', { err: e instanceof Error ? e.message : String(e) });
      return;
    }

    try {
      const { default: Z, ImplType } = loadZeroconfModule();
      this.zeroconf = new Z();
      this.publishName = `AirChat-${this.myDid.slice(-8)}`;
      if (Platform.OS === 'android') {
        this.zeroconf.publishService(
          SERVICE_TYPE,
          'tcp',
          'local.',
          this.publishName,
          this.port,
          { did: this.myDid },
          ImplType.NSD
        );
      } else {
        this.zeroconf.publishService(
          SERVICE_TYPE,
          'tcp',
          'local.',
          this.publishName,
          this.port,
          { did: this.myDid }
        );
      }
      this.zeroconf.on('resolved', (svc: Record<string, unknown>) => {
        try {
          const txt = svc.txt as Record<string, string> | undefined;
          const did = txt?.did?.trim();
          if (!did || did === this.myDid) return;
          // v4.32.195 (Round-25 #2): strict DID regex + anti-overwrite. Any
          // LAN device can publish txt.did matching a victim's DID; without
          // validation it'd replace the legitimate entry in peers map and
          // redirect send() traffic-analysis.
          if (!/^did:[a-z0-9]+:[A-Za-z0-9._-]{1,128}$/.test(did)) return;
          const port = typeof svc.port === 'number' ? svc.port : Number(svc.port);
          const host = pickHost({
            host: typeof svc.host === 'string' ? svc.host : undefined,
            addresses: Array.isArray(svc.addresses) ? (svc.addresses as string[]) : undefined,
          });
          if (!host || !port) return;
          // Drop overlapping (potentially spoofed) DID advertisements from a
          // different host within the TTL window.
          const existing = this.peers.get(did);
          if (existing && Date.now() - existing.lastSeen < PEER_DISCOVERY_DEBOUNCE_MS &&
              (existing.host !== host || existing.port !== port)) {
            log.warn('lan_peer_conflict_drop', { did: did.slice(0, 24), existing: existing.host, newHost: host });
            return;
          }
          // v4.32.67: триггерим onPeerDiscovered только для реально-новых или
          // долго-невидимых пиров. Плановый runScan каждые 45с иначе спамил бы
          // flush feed-queue при каждом resolve-event на стабильно онлайн-контакте.
          const prev = this.peers.get(did);
          const now = Date.now();
          const isNewOrStale = !prev || (now - prev.lastSeen) > PEER_DISCOVERY_DEBOUNCE_MS;
          // v4.32.201 (Round-31 #3): cap peers map at 256 to prevent hostile
          // LAN (captive portal / conference Wi-Fi) from flooding with DIDs.
          // When full and did not already present, drop the oldest-seen entry.
          if (!prev && this.peers.size >= 256) {
            let oldestDid: string | null = null;
            let oldestSeen = Infinity;
            for (const [pdid, p] of this.peers) {
              if (p.lastSeen < oldestSeen) { oldestSeen = p.lastSeen; oldestDid = pdid; }
            }
            if (oldestDid) this.peers.delete(oldestDid);
          }
          this.peers.set(did, { did, host, port, lastSeen: now });
          log.info('lan_peer_seen', { did: did.slice(0, 24), host, isNew: isNewOrStale });
          if (isNewOrStale && this.onPeerDiscovered) {
            try {
              this.onPeerDiscovered(did);
            } catch (err) {
              log.warn('lan_on_peer_discovered_failed', {
                err: err instanceof Error ? err.message : String(err),
              });
            }
          }
        } catch (err) {
          log.warn('lan_resolve_handler_failed', {
            err: err instanceof Error ? err.message : String(err),
          });
        }
      });
      const runScan = () => {
        try {
          if (Platform.OS === 'android') {
            this.zeroconf?.scan(SERVICE_TYPE, 'tcp', 'local.', ImplType.NSD);
          } else {
            this.zeroconf?.scan(SERVICE_TYPE, 'tcp', 'local.');
          }
        } catch (err) {
          log.warn('lan_scan_failed', { err: err instanceof Error ? err.message : String(err) });
        }
      };
      runScan();
      this.scanTimer = setInterval(runScan, SCAN_REFRESH_MS);
      this.ttlTimer = setInterval(() => this.prunePeers(), 20_000);
      this.active = true;
      log.info('lan_discovery_started', { service: `_${SERVICE_TYPE}._tcp` });
    } catch (e) {
      log.warn('lan_zeroconf_failed', { err: e instanceof Error ? e.message : String(e) });
      // v4.32.134 (AUDIT P2): drop the 'resolved' listener we may have
      // registered before the failure, so a subsequent start() doesn't stack
      // a second handler on top of the (still-alive) first one.
      try {
        this.zeroconf?.removeDeviceListeners?.();
      } catch { /* best effort */ }
      this.zeroconf = null;
      // v4.32.176: cleanup таймеров, которые могли быть созданы до throw —
      // иначе scanTimer/ttlTimer продолжали палить против nulled zeroconf.
      if (this.scanTimer) { clearInterval(this.scanTimer); this.scanTimer = null; }
      if (this.ttlTimer) { clearInterval(this.ttlTimer); this.ttlTimer = null; }
      this.stopTcpServerOnly();
    }
  }

  private prunePeers(): void {
    const now = Date.now();
    for (const [did, p] of this.peers) {
      if (now - p.lastSeen > PEER_TTL_MS) this.peers.delete(did);
    }
  }

  private stopTcpServerOnly(): void {
    if (this.inboundTimer) {
      clearInterval(this.inboundTimer);
      this.inboundTimer = null;
    }
    try {
      this.server?.close?.(() => {
        /* noop */
      });
    } catch {
      /* ignore */
    }
    this.server = null;
    // server.close() перестаёт принимать новые соединения, но уже открытые
    // живут дальше — их надо закрыть руками, иначе накопители кадров переживут
    // сам транспорт.
    this.inbound.closeAll();
  }

  stop(): void {
    if (this.scanTimer) {
      clearInterval(this.scanTimer);
      this.scanTimer = null;
    }
    if (this.ttlTimer) {
      clearInterval(this.ttlTimer);
      this.ttlTimer = null;
    }
    try {
      if (this.zeroconf) {
        const { ImplType } = loadZeroconfModule();
        try {
          if (Platform.OS === 'android') {
            this.zeroconf.stop(ImplType.NSD);
          } else {
            this.zeroconf.stop();
          }
        } catch {
          /* ignore */
        }
        if (this.publishName) {
          try {
            if (Platform.OS === 'android') {
              this.zeroconf.unpublishService(this.publishName, ImplType.NSD);
            } else {
              this.zeroconf.unpublishService(this.publishName);
            }
          } catch {
            /* ignore */
          }
        }
        this.zeroconf.removeDeviceListeners();
      }
    } catch {
      /* ignore */
    }
    this.zeroconf = null;
    this.publishName = '';
    this.stopTcpServerOnly();
    this.peers.clear();
    this.active = false;
    this.onFrame = undefined;
    this.onPeerDiscovered = undefined;
    log.info('lan_transport_stopped');
  }
}

let singleton: LanTransport | null = null;

export function getLanTransportSingleton(): LanTransport {
  if (!singleton) singleton = new LanTransport();
  return singleton;
}
