/**
 * Открытый ключ в БАЙТАХ: 32 — это одно число, а не семнадцать копий (v4.32.427).
 *
 * Проверяется ровно то, из-за чего правило и собрали в одно место: строка
 * может быть правильной длины и всё равно не быть ключом, а `Buffer.from` об
 * этом молчит.
 */

import {
  ED25519_PUBLIC_KEY_BYTES,
  ED25519_SIGNATURE_BYTES,
  isEd25519PublicKey,
  publicKeyFromB64,
  publicKeyToB64,
} from '../pubKeyFormat';

const REAL_BYTES = new Uint8Array(32).fill(7);
const REAL_B64 = Buffer.from(REAL_BYTES).toString('base64');

describe('длины названы, а не вписаны', () => {
  it('открытый ключ — 32 байта, подпись — 64', () => {
    expect(ED25519_PUBLIC_KEY_BYTES).toBe(32);
    expect(ED25519_SIGNATURE_BYTES).toBe(64);
  });
});

describe('isEd25519PublicKey', () => {
  it('ровно 32 байта — да, соседние длины — нет', () => {
    expect(isEd25519PublicKey(REAL_BYTES)).toBe(true);
    expect(isEd25519PublicKey(new Uint8Array(31))).toBe(false);
    expect(isEd25519PublicKey(new Uint8Array(33))).toBe(false);
    expect(isEd25519PublicKey(new Uint8Array(0))).toBe(false);
  });

  it('null и undefined — нет, и без исключения', () => {
    expect(isEd25519PublicKey(null)).toBe(false);
    expect(isEd25519PublicKey(undefined)).toBe(false);
  });
});

describe('publicKeyFromB64', () => {
  it('настоящий ключ разбирается, с выравниванием и без', () => {
    expect(publicKeyFromB64(REAL_B64)).toEqual(REAL_BYTES);
    expect(publicKeyFromB64(REAL_B64.replace(/=+$/, ''))).toEqual(REAL_BYTES);
  });

  it('url-safe форма разбирается — именно её присылают ссылки', () => {
    const urlSafe = REAL_B64.split('+').join('-').split('/').join('_');
    expect(publicKeyFromB64(urlSafe)).toEqual(REAL_BYTES);
  });

  it('Buffer.from не бросает — значит длину обязан проверить вызывающий', () => {
    // Измерено, а не предположено: ровно поэтому try/catch вокруг Buffer.from
    // в четырёх местах кода был мёртвым.
    expect(() => Buffer.from('!!!!', 'base64')).not.toThrow();
    expect(Buffer.from('!!!!', 'base64')).toHaveLength(0);
    expect(Buffer.from('A'.repeat(44), 'base64')).toHaveLength(33);
  });

  it('строка верной длины, но с управляющим символом — не ключ', () => {
    // Ровно эта дыра и закрывалась в v4.32.368 на уровне строки: 43 буквы плюс
    // один управляющий байт дают 44 символа, а Buffer.from выбрасывает лишний
    // молча и отдаёт честные 32 байта.
    const withControl = 'A'.repeat(43) + String.fromCharCode(1);
    expect(withControl).toHaveLength(44);
    expect(Buffer.from(withControl, 'base64')).toHaveLength(32);
    expect(publicKeyFromB64(withControl)).toBeNull();
  });

  it('строка из алфавита, но не той длины — не ключ', () => {
    // 48 символов проходят проверку строки (PUB_KEY_B64_MAX), но дают 36 байт.
    expect(publicKeyFromB64('A'.repeat(48))).toBeNull();
    expect(publicKeyFromB64('A'.repeat(43))).not.toBeNull();
  });

  it('не строка — null, а не исключение', () => {
    expect(publicKeyFromB64(null)).toBeNull();
    expect(publicKeyFromB64(undefined)).toBeNull();
    expect(publicKeyFromB64(42)).toBeNull();
    expect(publicKeyFromB64(REAL_BYTES)).toBeNull();
  });
});

describe('publicKeyToB64', () => {
  it('обе стороны получают одну и ту же строку', () => {
    expect(publicKeyToB64(REAL_BYTES)).toBe(REAL_B64);
    expect(publicKeyFromB64(publicKeyToB64(REAL_BYTES))).toEqual(REAL_BYTES);
  });
});
