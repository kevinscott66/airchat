import {
  INLINE_BLOB_PREFIX,
  decodeInlineBlob,
  encodeInlineBlob,
  isInlineBlobEncrypted,
  reencryptInlineBlob,
} from '../inlineBlobCrypto';

const DEK = new Uint8Array(32).fill(7);
const OTHER = new Uint8Array(32).fill(9);

/** Похоже на настоящее вложение: произвольные байты в base64. */
function fakeAttachment(bytes: number): string {
  const raw = new Uint8Array(bytes);
  for (let i = 0; i < bytes; i++) raw[i] = (i * 31 + 17) & 0xff;
  return Buffer.from(raw).toString('base64');
}

describe('inlineBlobCrypto', () => {
  // Неудачная расшифровка — ожидаемая часть половины проверок, и каждая пишет
  // предупреждение в лог. Под jest __DEV__ включён, и оно уходит в консоль.
  let warnSpy: jest.SpyInstance;
  beforeEach(() => {
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    warnSpy.mockRestore();
  });

  it('вложение читается обратно байт в байт', () => {
    const b64 = fakeAttachment(4096);
    const stored = encodeInlineBlob(b64, DEK);
    expect(stored).not.toContain(b64.slice(0, 32));
    expect(decodeInlineBlob(stored, DEK)).toBe(b64);
  });

  it('чужой ключ ничего не отдаёт', () => {
    const stored = encodeInlineBlob(fakeAttachment(256), DEK);
    expect(decodeInlineBlob(stored, OTHER)).toBeNull();
  });

  it('подмена байта в шифртексте ловится, а не отдаётся как содержимое', () => {
    const stored = encodeInlineBlob(fakeAttachment(256), DEK);
    const body = stored.slice(INLINE_BLOB_PREFIX.length);
    const flipped = body[40] === 'A' ? 'B' : 'A';
    const tampered = INLINE_BLOB_PREFIX + body.slice(0, 40) + flipped + body.slice(41);
    expect(decodeInlineBlob(tampered, DEK)).toBeNull();
  });

  it('запись, сделанная до шифрования, отдаётся как есть', () => {
    const legacy = fakeAttachment(64);
    expect(isInlineBlobEncrypted(legacy)).toBe(false);
    expect(decodeInlineBlob(legacy, DEK)).toBe(legacy);
  });

  it('base64 никогда не начинается с префикса — старое и новое не перепутать', () => {
    // Двоеточия нет в алфавите base64, так что совпадение невозможно в принципе;
    // проверяем на выборке, чтобы поймать смену префикса на несовместимый.
    expect(INLINE_BLOB_PREFIX).toContain(':');
    for (let n = 0; n < 64; n++) {
      expect(isInlineBlobEncrypted(fakeAttachment(n + 1))).toBe(false);
    }
  });

  it('одно и то же вложение каждый раз шифруется по-новому', () => {
    // Одинаковый шифртекст выдавал бы совпадение картинок между постами прямо
    // по файлу базы, без единого ключа.
    const b64 = fakeAttachment(512);
    expect(encodeInlineBlob(b64, DEK)).not.toBe(encodeInlineBlob(b64, DEK));
  });

  it('пустое вложение не ломает разбор', () => {
    expect(decodeInlineBlob(encodeInlineBlob('', DEK), DEK)).toBe('');
  });

  it('размер на диске не растёт против открытого хранения', () => {
    // Ради этого и заведён отдельный кодек: enc2 положил бы base64 поверх
    // base64. Допуск — служебные байты (префикс, nonce, тег) и выравнивание.
    const b64 = fakeAttachment(1024 * 64);
    expect(encodeInlineBlob(b64, DEK).length).toBeLessThan(b64.length + 128);
  });

  it('смена ключа переносит вложение', () => {
    const b64 = fakeAttachment(1024);
    const stored = encodeInlineBlob(b64, DEK);
    const moved = reencryptInlineBlob(stored, DEK, OTHER);
    expect(moved).not.toBeNull();
    expect(decodeInlineBlob(moved as string, OTHER)).toBe(b64);
    expect(decodeInlineBlob(moved as string, DEK)).toBeNull();
  });

  it('смена ключа не трогает то, что не расшифровалось', () => {
    const stored = encodeInlineBlob(fakeAttachment(128), DEK);
    // Старый ключ не тот — вернуть надо null, чтобы вызывающий оставил запись.
    expect(reencryptInlineBlob(stored, OTHER, DEK)).toBeNull();
  });

  it('смена ключа не трогает незашифрованную запись', () => {
    expect(reencryptInlineBlob(fakeAttachment(32), DEK, OTHER)).toBeNull();
  });
});
