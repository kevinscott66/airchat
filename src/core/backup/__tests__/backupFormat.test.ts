/**
 * Распознавание зашифрованной резервной копии по вставленному тексту (v4.32.376).
 *
 * Копию вставляют в то же поле, что и 24 слова: отдельного экрана у неё нет.
 * Значит вся развилка держится на этой функции.
 */
import { BACKUP_TEXT_MAX, looksLikeEncryptedBackup } from '../backupFormat';

const backup = (over: Record<string, unknown> = {}): string =>
  JSON.stringify({ v: 1, saltB64: 'AAAA', blobB64: 'BBBB', iters: 120000, ...over });

describe('looksLikeEncryptedBackup', () => {
  it('своя копия узнаётся, в том числе с пробелами по краям', () => {
    expect(looksLikeEncryptedBackup(backup())).toBe(true);
    expect(looksLikeEncryptedBackup(`\n  ${backup()}  \n`)).toBe(true);
  });

  it('список слов копией не считается', () => {
    // Слова bip39 — строчные латинские буквы, фигурной скобки среди них нет.
    expect(looksLikeEncryptedBackup('abandon ability able about above absent')).toBe(false);
    expect(looksLikeEncryptedBackup('1. abandon 2. ability')).toBe(false);
    expect(looksLikeEncryptedBackup('')).toBe(false);
    expect(looksLikeEncryptedBackup('   ')).toBe(false);
  });

  it('не JSON и не строка — не копия, без исключения наружу', () => {
    expect(looksLikeEncryptedBackup('{это не json')).toBe(false);
    expect(looksLikeEncryptedBackup('{}')).toBe(false);
    expect(looksLikeEncryptedBackup(null)).toBe(false);
    expect(looksLikeEncryptedBackup(42)).toBe(false);
    expect(looksLikeEncryptedBackup(undefined)).toBe(false);
  });

  it('чужой JSON без нужных полей — не копия', () => {
    expect(looksLikeEncryptedBackup(backup({ v: 2 }))).toBe(false);
    expect(looksLikeEncryptedBackup(backup({ saltB64: '' }))).toBe(false);
    expect(looksLikeEncryptedBackup(backup({ blobB64: 123 }))).toBe(false);
    expect(looksLikeEncryptedBackup(JSON.stringify({ hello: 'world' }))).toBe(false);
    expect(looksLikeEncryptedBackup(JSON.stringify([1, 2, 3]))).toBe(false);
  });

  it('гигантская вставка отбрасывается до разбора JSON', () => {
    // Многомегабайтная вставка вешает поток на JSON.parse; настоящая копия —
    // около двухсот байт.
    const huge = `{"v":1,"saltB64":"AAAA","blobB64":"${'B'.repeat(BACKUP_TEXT_MAX)}"}`;
    expect(huge.length).toBeGreaterThan(BACKUP_TEXT_MAX);
    expect(looksLikeEncryptedBackup(huge)).toBe(false);
  });
});
