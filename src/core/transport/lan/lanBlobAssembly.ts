/**
 * lanBlobAssembly — разбор заголовка и сборка чанков LAN-blob'а. Чистый модуль:
 * ни файловой системы, ни транспорта, ни логгера. Ввод-вывод остаётся в
 * lanBlob.ts, сюда переехало всё, что решает, принять кадр или выбросить.
 *
 * Формат кадра описан в lanBlob.ts.
 *
 * v4.32.337: раньше проверка заголовка и накопитель жили внутри одной функции
 * рядом с expo-file-system, и заявленный размер blob'а никак не связывался с
 * числом чанков. Кадр приходит от любого устройства в той же сети — значит это
 * недоверенный ввод, и проверять его надо там, где это можно проверить тестом.
 */
import { Buffer } from 'buffer';

export const LAN_BLOB_MAGIC = 0xb1;
export const LAN_BLOB_VERSION = 1;
export const LAN_BLOB_HEADER_LEN = 26;
export const LAN_BLOB_CHUNK_BYTES = 512 * 1024;
/** Максимальный размер blob'а (зеркало MAX_BLOB_BYTES + AEAD overhead). */
export const LAN_BLOB_MAX_TOTAL_BYTES = 8_500_000;
/** Капы сборщика: max одновременных blob'ов и суммарных байт в памяти. */
export const LAN_BLOB_MAX_INFLIGHT = 4;
export const LAN_BLOB_MAX_INFLIGHT_BYTES = 32 * 1024 * 1024;
export const LAN_BLOB_INFLIGHT_TTL_MS = 90_000;

export function isLanBlobFrame(payload: Uint8Array): boolean {
  return payload.length >= LAN_BLOB_HEADER_LEN && payload[0] === LAN_BLOB_MAGIC;
}

export interface LanBlobHeader {
  idHex: string;
  index: number;
  count: number;
  total: number;
}

export function encodeLanBlobChunk(
  idBytes: Uint8Array,
  index: number,
  count: number,
  total: number,
  chunk: Uint8Array
): Uint8Array {
  const out = new Uint8Array(LAN_BLOB_HEADER_LEN + chunk.length);
  out[0] = LAN_BLOB_MAGIC;
  out[1] = LAN_BLOB_VERSION;
  out.set(idBytes, 2);
  out[18] = (index >> 8) & 0xff;
  out[19] = index & 0xff;
  out[20] = (count >> 8) & 0xff;
  out[21] = count & 0xff;
  new DataView(out.buffer, out.byteOffset + 22, 4).setUint32(0, total, false);
  out.set(chunk, LAN_BLOB_HEADER_LEN);
  return out;
}

/** Сколько чанков должно быть у blob'а такого размера. Отправитель режет ровно так. */
export function expectedChunkCount(total: number): number {
  return Math.ceil(total / LAN_BLOB_CHUNK_BYTES);
}

/**
 * Разобрать заголовок и вернуть его, если кадр внутренне непротиворечив.
 *
 * Ключевая проверка — count против total. Без неё отправитель мог объявить
 * blob в один байт и прислать 64 чанка по полмегабайта: резервировался один
 * байт, съедалось тридцать два мегабайта, и общий кап памяти обходился
 * полностью. Число чанков однозначно выводится из размера, так что расхождение
 * означает либо сломанного отправителя, либо намеренную атаку — в обоих
 * случаях кадр не нужен.
 */
export function parseLanBlobHeader(payload: Uint8Array): LanBlobHeader | null {
  if (!isLanBlobFrame(payload) || payload[1] !== LAN_BLOB_VERSION) return null;
  const index = (payload[18] << 8) | payload[19];
  const count = (payload[20] << 8) | payload[21];
  const total = new DataView(payload.buffer, payload.byteOffset + 22, 4).getUint32(0, false);
  if (total === 0 || total > LAN_BLOB_MAX_TOTAL_BYTES) return null;
  if (count !== expectedChunkCount(total)) return null;
  if (index >= count) return null;
  const chunkLen = payload.length - LAN_BLOB_HEADER_LEN;
  if (chunkLen === 0 || chunkLen > LAN_BLOB_CHUNK_BYTES) return null;
  // Последний чанк короче, все остальные — ровно CHUNK_BYTES. Иначе сумма
  // принятого не сойдётся с заявленным размером, и место в памяти уйдёт зря.
  const expectedLen = index === count - 1 ? total - index * LAN_BLOB_CHUNK_BYTES : LAN_BLOB_CHUNK_BYTES;
  if (chunkLen !== expectedLen) return null;
  const idHex = Buffer.from(payload.subarray(2, 18)).toString('hex');
  return { idHex, index, count, total };
}

interface Inflight {
  chunks: (Uint8Array | null)[];
  receivedBytes: number;
  total: number;
  ts: number;
}

export type AcceptResult =
  | { kind: 'need_more' }
  | { kind: 'dropped'; reason: 'capacity' | 'conflict' | 'duplicate' }
  | { kind: 'complete'; bytes: Uint8Array };

/**
 * Накопитель чанков. Держит незавершённые blob'ы в памяти под двумя капами:
 * число одновременных и суммарный ЗАЯВЛЕННЫЙ объём. Резервируем по total, а не
 * по уже принятому: иначе четвёртый blob пускается по факту пустоты соседей, и
 * пик памяти оказывается выше капа.
 */
export class LanBlobAssembler {
  private readonly inflight = new Map<string, Inflight>();

  get size(): number {
    return this.inflight.size;
  }

  sweep(now: number): void {
    for (const [k, v] of this.inflight) {
      if (now - v.ts > LAN_BLOB_INFLIGHT_TTL_MS) this.inflight.delete(k);
    }
  }

  /** Сумма заявленных размеров всех незавершённых blob'ов. */
  private reservedBytes(): number {
    let sum = 0;
    for (const v of this.inflight.values()) sum += v.total;
    return sum;
  }

  accept(header: LanBlobHeader, chunk: Uint8Array, now: number): AcceptResult {
    this.sweep(now);
    let st = this.inflight.get(header.idHex);
    if (!st) {
      if (
        this.inflight.size >= LAN_BLOB_MAX_INFLIGHT ||
        this.reservedBytes() + header.total > LAN_BLOB_MAX_INFLIGHT_BYTES
      ) {
        return { kind: 'dropped', reason: 'capacity' };
      }
      st = {
        chunks: new Array<Uint8Array | null>(header.count).fill(null),
        receivedBytes: 0,
        total: header.total,
        ts: now,
      };
      this.inflight.set(header.idHex, st);
    }
    // Тот же id с другим размером — либо коллизия, либо подмена на полпути.
    if (st.chunks.length !== header.count || st.total !== header.total) {
      return { kind: 'dropped', reason: 'conflict' };
    }
    if (st.chunks[header.index]) return { kind: 'dropped', reason: 'duplicate' };

    // Копия: payload-буфер переиспользуется аккумулятором кадров.
    const copy = new Uint8Array(chunk.length);
    copy.set(chunk);
    st.chunks[header.index] = copy;
    st.receivedBytes += copy.length;
    st.ts = now;

    if (st.receivedBytes < st.total) return { kind: 'need_more' };

    this.inflight.delete(header.idHex);
    const full = new Uint8Array(st.total);
    let offset = 0;
    for (const c of st.chunks) {
      if (!c) return { kind: 'dropped', reason: 'conflict' };
      full.set(c, offset);
      offset += c.length;
    }
    return { kind: 'complete', bytes: full };
  }

  forget(idHex: string): void {
    this.inflight.delete(idHex);
  }
}
