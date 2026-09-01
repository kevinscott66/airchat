/**
 * LoRa / Meshtastic: фрейминг в формате, совместимом с идеей Meshtastic (magic + From/To + PortNum + payload).
 * Реальная работа — protobuf по USB/BLE; здесь бинарный контракт и программная очередь.
 */
export type LoRaConfig = {
  port: string;
  baudRate: number;
  channel: number;
  encryptionKey: string;
  simulate?: boolean;
};

const MESH_MAGIC = 0x94c3;
const TEXT_MESSAGE_APP = 1;

function u16LE(n: number): Uint8Array {
  const b = new Uint8Array(2);
  b[0] = n & 0xff;
  b[1] = (n >> 8) & 0xff;
  return b;
}

function readU16LE(buf: Uint8Array, off: number): number {
  return buf[off]! | (buf[off + 1]! << 8);
}

function concat(parts: Uint8Array[]): Uint8Array {
  let len = 0;
  for (const p of parts) len += p.length;
  const out = new Uint8Array(len);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** Собирает Meshtastic-подобный пакет: magic, from, to, portnum, payload. */
export function buildMeshtasticFrame(
  fromNodeId: number,
  toNodeId: number,
  portNum: number,
  payload: Uint8Array
): Uint8Array {
  const header = concat([
    u16LE(MESH_MAGIC),
    u16LE(fromNodeId & 0xffff),
    u16LE(toNodeId & 0xffff),
    u16LE(portNum & 0xffff),
    u16LE(payload.length),
  ]);
  return concat([header, payload]);
}

export function parseMeshtasticFrame(buf: Uint8Array): {
  from: number;
  to: number;
  portNum: number;
  payload: Uint8Array;
} | null {
  if (buf.length < 12) return null;
  if (readU16LE(buf, 0) !== MESH_MAGIC) return null;
  const from = readU16LE(buf, 2);
  const to = readU16LE(buf, 4);
  const portNum = readU16LE(buf, 6);
  const len = readU16LE(buf, 8);
  if (12 + len > buf.length) return null;
  return {
    from,
    to,
    portNum,
    payload: buf.slice(12, 12 + len),
  };
}

export class LoRaTransport {
  private port: unknown = null;
  private isConnected = false;
  private readonly config: LoRaConfig;
  private nodeId = 0xace;
  private readonly rxQueue: { from: string; data: Uint8Array }[] = [];

  constructor(config: LoRaConfig) {
    this.config = config;
  }

  async connect(): Promise<boolean> {
    void this.port;
    if (this.config.simulate) {
      this.isConnected = true;
      console.log('[LoRa] Connected (simulate), Meshtastic-style framing');
      return true;
    }
    console.log('[LoRa] Connect serial/BLE and use Meshtastic protobuf API');
    this.isConnected = false;
    return false;
  }

  async send(data: Uint8Array, targetNodeId: string): Promise<boolean> {
    if (!this.isConnected) return false;
    const to = parseInt(targetNodeId.replace(/\D/g, ''), 10) || 0xffff;
    const frame = buildMeshtasticFrame(this.nodeId, to, TEXT_MESSAGE_APP, data);
    void frame;
    if (this.config.simulate) {
      const parsed = parseMeshtasticFrame(frame);
      if (parsed) {
        this.rxQueue.push({
          from: String(parsed.from),
          data: parsed.payload,
        });
      }
    }
    return true;
  }

  async receive(): Promise<{ from: string; data: Uint8Array } | null> {
    if (!this.isConnected) return null;
    return this.rxQueue.shift() ?? null;
  }

  setLocalNodeId(id: number): void {
    this.nodeId = id & 0xffff;
  }
}
