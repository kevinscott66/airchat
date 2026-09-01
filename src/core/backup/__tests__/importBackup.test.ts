/**
 * Загрузка зашифрованной резервной копии (v4.32.376).
 *
 * До этой версии функцию не вызывал ни один экран: копию можно было выдать и
 * нельзя было принять обратно. Здесь проверяются все отказы — то есть ровно то,
 * что человек увидит на экране, потому что текст ошибки экран показывает как есть.
 *
 * Успешный путь сюда не входит: он сохраняет ключи в SecureStore, и его место —
 * на устройстве, а не в jest.
 */
import { pbkdf2 } from '@noble/hashes/pbkdf2.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { encryptSymmetric } from '../../crypto/encrypt';
import { importEncryptedBackup } from '../seedPhrase';
import { BACKUP_TEXT_MAX } from '../backupFormat';

const ITERS = 120_000;
const SALT = new Uint8Array(16).fill(7);

/** Собирает копию того же вида, что и exportEncryptedBackup. */
function makeBackup(plain: string, password: string): string {
  const key = pbkdf2(sha256, new TextEncoder().encode(password.normalize('NFC')), SALT, {
    c: ITERS,
    dkLen: 32,
  });
  const ct = encryptSymmetric(key, new TextEncoder().encode(plain));
  return JSON.stringify({
    v: 1,
    saltB64: Buffer.from(SALT).toString('base64'),
    blobB64: Buffer.from(ct).toString('base64'),
    iters: ITERS,
  });
}

const NOT_A_BACKUP = 'Это не похоже на резервную копию AirChat.';

describe('importEncryptedBackup: отказы', () => {
  it('вставили не то — понятный текст, а не ошибка разбора JSON', async () => {
    // Раньше JSON.parse стоял без защиты, и наружу уходило сообщение движка
    // вида «Unexpected token … in JSON at position 5» — его-то экран и
    // показывал человеку, вставившему из буфера не ту строку.
    await expect(importEncryptedBackup('abandon ability able', 'pwd')).rejects.toThrow(NOT_A_BACKUP);
    await expect(importEncryptedBackup('{битый', 'pwd')).rejects.toThrow(NOT_A_BACKUP);
    await expect(importEncryptedBackup('', 'pwd')).rejects.toThrow(NOT_A_BACKUP);
  });

  it('JSON есть, а полей нет — тот же отказ', async () => {
    await expect(importEncryptedBackup('{}', 'pwd')).rejects.toThrow(NOT_A_BACKUP);
    await expect(importEncryptedBackup('null', 'pwd')).rejects.toThrow(NOT_A_BACKUP);
    await expect(importEncryptedBackup('[1,2,3]', 'pwd')).rejects.toThrow(NOT_A_BACKUP);
    await expect(
      importEncryptedBackup(JSON.stringify({ v: 2, saltB64: 'a', blobB64: 'b' }), 'pwd')
    ).rejects.toThrow(NOT_A_BACKUP);
  });

  it('гигантская вставка отбрасывается до разбора', async () => {
    await expect(importEncryptedBackup('{'.repeat(BACKUP_TEXT_MAX + 1), 'pwd')).rejects.toThrow(
      NOT_A_BACKUP
    );
  });

  it('неверный пароль — про пароль, а не про формат', async () => {
    const b = makeBackup('abandon abandon abandon', 'правильный');
    await expect(importEncryptedBackup(b, 'неправильный')).rejects.toThrow(/Неверный пароль/);
  });

  it('пароль верный, а слов внутри нет — говорим именно это', async () => {
    // Расшифровалось значит пароль верен. Но копию мог собрать не наш экспорт,
    // и без этой проверки дальше падало английское «Invalid seed phrase»
    // посреди восстановления.
    const b = makeBackup('это не мнемоника', 'pwd');
    await expect(importEncryptedBackup(b, 'pwd')).rejects.toThrow(/секретных слов в ней нет/);
  });
});
