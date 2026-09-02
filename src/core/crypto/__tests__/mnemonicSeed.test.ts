/**
 * Seed считается один раз на кошелёк — и это тот же seed (v4.32.542).
 *
 * Дефект. `mnemonicToSeedSync` — PBKDF2-HMAC-SHA512 × 2048 на чистом JS, около
 * двух секунд занятого JS-потока на Hermes. Звали его заново на каждый запрос
 * синхронизации (трижды за запрос), на каждое вложение и на каждую операцию с
 * облаком. Пока адрес облака был нерабочим, вызов всё равно происходил — и
 * только потом падал запрос. Кэш обязан быть привязан к самой фразе: подмена
 * seed чужим кошельком означала бы чужие ключи и чужой каталог хранилища.
 */
import { generateMnemonic, mnemonicToSeedSync } from 'bip39';
import { mnemonicSeedCached, clearMnemonicSeedCache } from '../mnemonicSeed';

describe('mnemonicSeedCached', () => {
  beforeEach(() => clearMnemonicSeedCache());

  it('совпадает с прямым bip39-выводом', () => {
    const m = generateMnemonic(256);
    const direct = new Uint8Array(mnemonicToSeedSync(m));
    expect(Buffer.from(mnemonicSeedCached(m)).equals(Buffer.from(direct))).toBe(true);
  });

  it('повторный вызов той же фразы отдаёт тот же буфер', () => {
    const m = generateMnemonic(256);
    expect(mnemonicSeedCached(m)).toBe(mnemonicSeedCached(m));
  });

  it('другая фраза не получает чужой seed', () => {
    const a = generateMnemonic(256);
    const b = generateMnemonic(256);
    const seedA = Buffer.from(mnemonicSeedCached(a));
    const seedB = Buffer.from(mnemonicSeedCached(b));
    expect(seedA.equals(seedB)).toBe(false);
    expect(seedB.equals(Buffer.from(mnemonicToSeedSync(b)))).toBe(true);
    // Возврат к первой фразе не должен отдавать seed второй.
    expect(Buffer.from(mnemonicSeedCached(a)).equals(seedA)).toBe(true);
  });

  it('после сброса кэша seed прежний, а буфер новый', () => {
    const m = generateMnemonic(256);
    const first = mnemonicSeedCached(m);
    clearMnemonicSeedCache();
    const second = mnemonicSeedCached(m);
    expect(second).not.toBe(first);
    expect(Buffer.from(second).equals(Buffer.from(first))).toBe(true);
  });
});
