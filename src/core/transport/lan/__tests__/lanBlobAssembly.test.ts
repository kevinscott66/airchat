import {
  LAN_BLOB_CHUNK_BYTES,
  LAN_BLOB_HEADER_LEN,
  LAN_BLOB_MAGIC,
  LAN_BLOB_MAX_INFLIGHT,
  LAN_BLOB_MAX_TOTAL_BYTES,
  LanBlobAssembler,
  encodeLanBlobChunk,
  expectedChunkCount,
  isLanBlobFrame,
  parseLanBlobHeader,
} from '../lanBlobAssembly';

/**
 * Кадр 0xB1 приходит от любого устройства в той же Wi-Fi сети и попадает в
 * накопитель до какой-либо проверки отправителя. Всё, что здесь проверяется, —
 * поведение на недоверенном вводе.
 */

const NOW = 1_700_000_000_000;

function idBytes(seed: number): Uint8Array {
  const b = new Uint8Array(16);
  b.fill(seed & 0xff);
  return b;
}

function idHexOf(seed: number): string {
  return (seed & 0xff).toString(16).padStart(2, '0').repeat(16);
}

/** Кадр, который построил бы честный отправитель. */
function frame(seed: number, index: number, total: number): Uint8Array {
  const count = expectedChunkCount(total);
  const len = index === count - 1 ? total - index * LAN_BLOB_CHUNK_BYTES : LAN_BLOB_CHUNK_BYTES;
  const chunk = new Uint8Array(len);
  chunk.fill((index + 1) & 0xff);
  return encodeLanBlobChunk(idBytes(seed), index, count, total, chunk);
}

function chunkOf(f: Uint8Array): Uint8Array {
  return f.subarray(LAN_BLOB_HEADER_LEN);
}

describe('isLanBlobFrame', () => {
  it('короче заголовка — не наш кадр', () => {
    const short = new Uint8Array(LAN_BLOB_HEADER_LEN - 1);
    short[0] = LAN_BLOB_MAGIC;
    expect(isLanBlobFrame(short)).toBe(false);
  });

  it('чужой magic — не наш кадр', () => {
    const f = frame(1, 0, 100);
    f[0] = 0xf0;
    expect(isLanBlobFrame(f)).toBe(false);
  });
});

describe('parseLanBlobHeader', () => {
  it('честный кадр разбирается', () => {
    const total = LAN_BLOB_CHUNK_BYTES + 10;
    const h = parseLanBlobHeader(frame(0xab, 1, total));
    expect(h).toEqual({ idHex: idHexOf(0xab), index: 1, count: 2, total });
  });

  it('чужая версия отбрасывается', () => {
    const f = frame(1, 0, 100);
    f[1] = 2;
    expect(parseLanBlobHeader(f)).toBeNull();
  });

  it('нулевой и запредельный размер отбрасываются', () => {
    const zero = frame(1, 0, 100);
    new DataView(zero.buffer, zero.byteOffset + 22, 4).setUint32(0, 0, false);
    expect(parseLanBlobHeader(zero)).toBeNull();

    const huge = frame(1, 0, 100);
    new DataView(huge.buffer, huge.byteOffset + 22, 4).setUint32(0, LAN_BLOB_MAX_TOTAL_BYTES + 1, false);
    expect(parseLanBlobHeader(huge)).toBeNull();
  });

  it('число чанков, не выводимое из размера, отбрасывается', () => {
    // Ровно этим обходился кап памяти: «весь blob — один байт, чанков 64».
    const f = frame(1, 0, 100);
    f[20] = 0;
    f[21] = 64;
    expect(parseLanBlobHeader(f)).toBeNull();
  });

  it('индекс за пределами набора отбрасывается', () => {
    const f = frame(1, 0, 100);
    f[18] = 0;
    f[19] = 5;
    expect(parseLanBlobHeader(f)).toBeNull();
  });

  it('пустой чанк отбрасывается', () => {
    const f = frame(1, 0, 100).subarray(0, LAN_BLOB_HEADER_LEN);
    expect(parseLanBlobHeader(f)).toBeNull();
  });

  it('чанк не того размера, что обещает заголовок, отбрасывается', () => {
    const total = LAN_BLOB_CHUNK_BYTES + 10;
    // Первый чанк обязан быть ровно CHUNK_BYTES: короче — сумма не сойдётся.
    const short = encodeLanBlobChunk(idBytes(1), 0, 2, total, new Uint8Array(1000));
    expect(parseLanBlobHeader(short)).toBeNull();
    // Последний обязан быть ровно остатком.
    const longTail = encodeLanBlobChunk(idBytes(1), 1, 2, total, new Uint8Array(11));
    expect(parseLanBlobHeader(longTail)).toBeNull();
  });

  it('однобайтовый blob — один чанк в один байт', () => {
    const h = parseLanBlobHeader(encodeLanBlobChunk(idBytes(7), 0, 1, 1, new Uint8Array(1)));
    expect(h).toEqual({ idHex: idHexOf(7), index: 0, count: 1, total: 1 });
  });
});

describe('LanBlobAssembler', () => {
  function accept(a: LanBlobAssembler, f: Uint8Array, now = NOW) {
    const h = parseLanBlobHeader(f);
    if (!h) throw new Error('кадр должен быть валидным');
    return a.accept(h, chunkOf(f), now);
  }

  it('собирает blob из одного чанка', () => {
    const a = new LanBlobAssembler();
    const res = accept(a, frame(1, 0, 300));
    expect(res.kind).toBe('complete');
    if (res.kind !== 'complete') return;
    expect(res.bytes.length).toBe(300);
    expect(res.bytes[0]).toBe(1);
    expect(a.size).toBe(0);
  });

  it('собирает многочанковый blob и складывает байты по порядку', () => {
    const a = new LanBlobAssembler();
    const total = LAN_BLOB_CHUNK_BYTES * 2 + 7;
    // Порядок прихода не гарантирован транспортом — присылаем вразнобой.
    expect(accept(a, frame(2, 2, total)).kind).toBe('need_more');
    expect(accept(a, frame(2, 0, total)).kind).toBe('need_more');
    const res = accept(a, frame(2, 1, total));
    expect(res.kind).toBe('complete');
    if (res.kind !== 'complete') return;
    expect(res.bytes.length).toBe(total);
    expect(res.bytes[0]).toBe(1);
    expect(res.bytes[LAN_BLOB_CHUNK_BYTES]).toBe(2);
    expect(res.bytes[LAN_BLOB_CHUNK_BYTES * 2]).toBe(3);
  });

  it('дубль чанка не считается дважды и не ломает сборку', () => {
    const a = new LanBlobAssembler();
    const total = LAN_BLOB_CHUNK_BYTES + 5;
    expect(accept(a, frame(3, 0, total)).kind).toBe('need_more');
    const dup = accept(a, frame(3, 0, total));
    expect(dup.kind === 'dropped' && dup.reason).toBe('duplicate');
    expect(accept(a, frame(3, 1, total)).kind).toBe('complete');
  });

  it('тот же id с другим размером отбрасывается, начатая сборка не портится', () => {
    const a = new LanBlobAssembler();
    const total = LAN_BLOB_CHUNK_BYTES + 5;
    expect(accept(a, frame(4, 0, total)).kind).toBe('need_more');
    const conflict = accept(a, frame(4, 0, 999));
    expect(conflict.kind === 'dropped' && conflict.reason).toBe('conflict');
    expect(accept(a, frame(4, 1, total)).kind).toBe('complete');
  });

  it('больше четырёх одновременных blob’ов не принимается', () => {
    const a = new LanBlobAssembler();
    const total = LAN_BLOB_CHUNK_BYTES + 5;
    for (let i = 0; i < LAN_BLOB_MAX_INFLIGHT; i++) {
      expect(accept(a, frame(10 + i, 0, total)).kind).toBe('need_more');
    }
    const over = accept(a, frame(99, 0, total));
    expect(over.kind === 'dropped' && over.reason).toBe('capacity');
    expect(a.size).toBe(LAN_BLOB_MAX_INFLIGHT);
  });

  it('резерв считается по заявленному размеру, а не по принятому', () => {
    // Четыре blob'а по 8.5 MB — это 34 MB, кап 32 MB. Раньше резерв считался по
    // фактически принятым байтам, и четвёртый пролезал на пустом месте.
    const a = new LanBlobAssembler();
    const total = LAN_BLOB_MAX_TOTAL_BYTES;
    for (let i = 0; i < 3; i++) {
      expect(accept(a, frame(20 + i, 0, total)).kind).toBe('need_more');
    }
    const over = accept(a, frame(23, 0, total));
    expect(over.kind === 'dropped' && over.reason).toBe('capacity');
  });

  it('брошенная на полпути сборка вычищается по TTL', () => {
    const a = new LanBlobAssembler();
    const total = LAN_BLOB_CHUNK_BYTES + 5;
    accept(a, frame(5, 0, total));
    expect(a.size).toBe(1);
    a.sweep(NOW + 90_001);
    expect(a.size).toBe(0);
    // После вычистки первый же чанк начинает сборку заново, а не дополняет старую.
    expect(accept(a, frame(5, 1, total), NOW + 90_001).kind).toBe('need_more');
  });

  it('живая сборка не вычищается, пока чанки идут', () => {
    const a = new LanBlobAssembler();
    const total = LAN_BLOB_CHUNK_BYTES * 2 + 1;
    accept(a, frame(6, 0, total), NOW);
    accept(a, frame(6, 1, total), NOW + 80_000);
    a.sweep(NOW + 100_000);
    expect(a.size).toBe(1);
  });

  it('forget убирает сборку', () => {
    const a = new LanBlobAssembler();
    accept(a, frame(8, 0, LAN_BLOB_CHUNK_BYTES + 5));
    a.forget(idHexOf(8));
    expect(a.size).toBe(0);
  });
});
