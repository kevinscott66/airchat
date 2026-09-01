/**
 * Форма публичного ключа: что считается ключом (v4.32.368).
 */

import { isPubKeyB64, PUB_KEY_B64_MIN, PUB_KEY_B64_MAX } from '../pubKeyFormat';

/** Настоящий ключ: 32 байта в base64. */
const REAL = Buffer.from(new Uint8Array(32).fill(7)).toString('base64');

describe('isPubKeyB64', () => {
  it('настоящий ключ проходит', () => {
    expect(REAL).toHaveLength(44);
    expect(isPubKeyB64(REAL)).toBe(true);
    // Без выравнивания — тоже ключ: так его пишут в ссылках.
    expect(isPubKeyB64(REAL.replace(/=+$/, ''))).toBe(true);
  });

  it('url-safe алфавит принимается', () => {
    expect(isPubKeyB64(`${'a'.repeat(20)}-${'b'.repeat(20)}_ab`)).toBe(true);
  });

  it('длина проверяется с обеих сторон', () => {
    expect(isPubKeyB64('A'.repeat(PUB_KEY_B64_MIN - 1))).toBe(false);
    expect(isPubKeyB64('A'.repeat(PUB_KEY_B64_MIN))).toBe(true);
    expect(isPubKeyB64('A'.repeat(PUB_KEY_B64_MAX))).toBe(true);
    expect(isPubKeyB64('A'.repeat(PUB_KEY_B64_MAX + 1))).toBe(false);
  });

  it('управляющий символ не проходит, хотя длина верная', () => {
    // Ровно этот случай и был дырой: 43 буквы плюс один управляющий байт —
    // ровно 44 символа, «правильная» длина, и в список участников группы
    // попадала запись, за которой нет человека.
    expect(isPubKeyB64(`${'A'.repeat(43)}\x07`)).toBe(false);
    expect(isPubKeyB64(`${'A'.repeat(43)}\x00`)).toBe(false);
  });

  it('невидимая метка направления письма не проходит', () => {
    expect(isPubKeyB64(`${'A'.repeat(43)}\u202e`)).toBe(false);
  });

  it('кириллица не проходит', () => {
    // Похоже на латиницу на экране, но это другой ключ и другой человек.
    expect(isPubKeyB64('А'.repeat(44))).toBe(false);
    expect(isPubKeyB64(`${'A'.repeat(43)}О`)).toBe(false);
  });

  it('пробелы и переводы строк не проходят', () => {
    expect(isPubKeyB64(`${'A'.repeat(42)} `)).toBe(false);
    expect(isPubKeyB64(`${'A'.repeat(42)}\n`)).toBe(false);
  });

  it('не строка — не ключ', () => {
    for (const v of [null, undefined, 42, {}, [], true]) {
      expect(isPubKeyB64(v)).toBe(false);
    }
  });
});
