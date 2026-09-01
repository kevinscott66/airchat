/** Бинарный кадр LAN: ACPT + версия + sender did + payload (обычно JSON envelope). */

const MAGIC = new Uint8Array([0x41, 0x43, 0x50, 0x54]); // "ACPT"
const VERSION = 1;

export function encodeLanFrame(senderDid: string, payload: Uint8Array): Uint8Array {
  const didBytes = new TextEncoder().encode(senderDid);
  if (didBytes.length > 65535) throw new Error('lan_sender_did_too_long');
  const plen = payload.length;
  const out = new Uint8Array(4 + 1 + 2 + didBytes.length + 4 + plen);
  let o = 0;
  out.set(MAGIC, o);
  o += 4;
  out[o++] = VERSION;
  out[o++] = (didBytes.length >> 8) & 0xff;
  out[o++] = didBytes.length & 0xff;
  out.set(didBytes, o);
  o += didBytes.length;
  new DataView(out.buffer, out.byteOffset + o, 4).setUint32(0, plen, false);
  o += 4;
  out.set(payload, o);
  return out;
}

export type ParsedLanFrame = { senderDid: string; payload: Uint8Array };

function concat(a: Uint8Array, b: Uint8Array): Uint8Array<ArrayBuffer> {
  const ab = new ArrayBuffer(a.length + b.length);
  const out = new Uint8Array(ab);
  out.set(a, 0);
  out.set(b, a.length);
  return out as Uint8Array<ArrayBuffer>;
}

/** Копия в новый ArrayBuffer — стабильный тип для TS 5.9 (Uint8Array<ArrayBuffer>). */
function copyU8(u: Uint8Array): Uint8Array<ArrayBuffer> {
  const ab = new ArrayBuffer(u.byteLength);
  const out = new Uint8Array(ab);
  out.set(u);
  return out as Uint8Array<ArrayBuffer>;
}

function matchMagic(buf: Uint8Array, o: number): boolean {
  if (o + 4 > buf.length) return false;
  for (let i = 0; i < 4; i++) if (buf[o + i] !== MAGIC[i]) return false;
  return true;
}

/**
 * Вырезает полные кадры из буфера; неполный хвост остаётся.
 */
export class LanFrameAccumulator {
  private buf: Uint8Array<ArrayBuffer> = new Uint8Array(0) as Uint8Array<ArrayBuffer>;

  append(chunk: Uint8Array): ParsedLanFrame[] {
    // v4.32.338: concat уже выделяет свежий буфер и копирует в него — обёртка
    // copyU8 поверх копировала всё второй раз. На кадре в полмегабайта,
    // приходящем сотней TCP-чанков, это лишние сотни мегабайт memcpy.
    // Копия исходного chunk нужна только когда он становится буфером напрямую:
    // вызывающий переиспользует свой массив.
    this.buf = this.buf.length === 0 ? copyU8(chunk) : concat(this.buf, chunk);
    const frames: ParsedLanFrame[] = [];
    let offset = 0;
    while (offset + 7 <= this.buf.length) {
      if (!matchMagic(this.buf, offset)) {
        offset += 1;
        continue;
      }
      if (this.buf[offset + 4] !== VERSION) {
        offset += 1;
        continue;
      }
      const didLen = (this.buf[offset + 5] << 8) | this.buf[offset + 6];
      if (offset + 11 + didLen > this.buf.length) break;
      const payloadLen = new DataView(
        this.buf.buffer,
        this.buf.byteOffset + offset + 7 + didLen,
        4
      ).getUint32(0, false);
      // Sanity guard: reject frames claiming payload > 1 MB (prevent OOM from spoofed wire data)
      if (payloadLen > 1_048_576) { offset += 1; continue; }
      const total = 11 + didLen + payloadLen;
      if (offset + total > this.buf.length) break;
      const senderDid = new TextDecoder().decode(this.buf.subarray(offset + 7, offset + 7 + didLen));
      const payload = copyU8(
        this.buf.subarray(offset + 11 + didLen, offset + 11 + didLen + payloadLen)
      );
      frames.push({ senderDid, payload });
      offset += total;
    }
    this.buf =
      offset >= this.buf.length ? new Uint8Array(0) : copyU8(this.buf.subarray(offset));
    return frames;
  }
}
