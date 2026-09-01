import type { GeographicRouter, RelayNode } from './geographicRouter';

export type OpportunisticSyncDeps = {
  geographicRouter?: GeographicRouter;
  getMyDid?: () => Promise<string>;
  /** Доставка сырых байт контакту (BLE/IPFS/WebRTC — снаружи). */
  deliverPayload?: (peerDid: string, kind: string, payload: Uint8Array) => Promise<void>;
};

export type TopologyExchangePayload = {
  relays: RelayNode[];
  senderDid: string;
};

/**
 * Синхронизация при встрече: обмен топологией (ретрансляторы), «почта» и очередь ретрансляции.
 */
// v4.32.200 (Round-30 #1/#2): hard caps for untrusted-peer topology frames
// and per-peer mailbox growth.
const TOPOLOGY_FRAME_MAX_BYTES = 64 * 1024;
const TOPOLOGY_RELAYS_MAX = 256;
const PENDING_PEERS_MAX = 1024;
const PENDING_PER_PEER_MAX = 256;

export class OpportunisticSync {
  private readonly pendingForPeer = new Map<string, Uint8Array[]>();

  constructor(private readonly deps: OpportunisticSyncDeps = {}) {}

  onDeviceDetected = async (device: { did: string; transports: string[] }): Promise<void> => {
    console.log(`[Sync] Device detected: ${device.did}`, device.transports);
    await this.exchangeTopology(device);
    await this.fetchMessagesForMe(device.did);
    await this.exchangeRelayMessages(device.did);
  };

  /** Вызывается при входящем BLE/Wi‑Fi кадре с топологией. */
  async ingestTopologyFrame(peerDid: string, frame: Uint8Array): Promise<void> {
    try {
      // v4.32.200 (Round-30 #1): cap frame + relay array before merge. A
      // neighboring BLE/Wi-Fi peer can otherwise send multi-MB JSON that
      // stalls the JS thread or a 10k-relay array that floods the router.
      if (frame.byteLength > TOPOLOGY_FRAME_MAX_BYTES) return;
      const text = new TextDecoder().decode(frame);
      const parsed = JSON.parse(text) as TopologyExchangePayload;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return;
      if (!Array.isArray(parsed.relays)) return;
      if (parsed.relays.length === 0 || parsed.relays.length > TOPOLOGY_RELAYS_MAX) return;
      if (this.deps.geographicRouter) {
        this.deps.geographicRouter.mergeTopology(parsed.relays);
      }
      void peerDid;
    } catch {
      /* ignore malformed */
    }
  }

  queueForPeerWhenOnline(peerDid: string, payload: Uint8Array): void {
    // v4.32.200 (Round-30 #2): cap peers and per-peer queue depth. Without
    // this, a flood of queues (misbehaving peer or upstream bug) retains
    // unbounded bytes until process exit.
    let q = this.pendingForPeer.get(peerDid);
    if (!q) {
      if (this.pendingForPeer.size >= PENDING_PEERS_MAX) {
        const oldest = this.pendingForPeer.keys().next().value;
        if (oldest !== undefined) this.pendingForPeer.delete(oldest);
      }
      q = [];
      this.pendingForPeer.set(peerDid, q);
    }
    if (q.length >= PENDING_PER_PEER_MAX) q.shift();
    q.push(new Uint8Array(payload));
  }

  private async exchangeTopology(device: { did: string; transports: string[] }): Promise<void> {
    const router = this.deps.geographicRouter;
    const myDid = (await this.deps.getMyDid?.()) ?? 'did:unknown:local';
    if (!router) return;
    const payload: TopologyExchangePayload = {
      senderDid: myDid,
      relays: router.getRelays(),
    };
    const bytes = new TextEncoder().encode(JSON.stringify(payload));
    await this.deps.deliverPayload?.(device.did, 'topology', bytes);
    void device.transports;
  }

  private async fetchMessagesForMe(peerDid: string): Promise<void> {
    const myDid = await this.deps.getMyDid?.();
    if (!myDid) return;
    const q = this.pendingForPeer.get(myDid);
    if (!q?.length) return;
    for (const chunk of q) {
      await this.deps.deliverPayload?.(peerDid, 'sync', chunk);
    }
    this.pendingForPeer.delete(myDid);
  }

  private async exchangeRelayMessages(peerDid: string): Promise<void> {
    const q = this.pendingForPeer.get(peerDid);
    if (!q?.length) return;
    for (const chunk of q) {
      await this.deps.deliverPayload?.(peerDid, 'relay', chunk);
    }
    this.pendingForPeer.delete(peerDid);
  }
}
