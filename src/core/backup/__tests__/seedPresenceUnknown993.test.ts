/**
 * Дефект. Экран профиля писал «Секретные слова на этом устройстве не найдены —
 * при необходимости пройдите настройку заново» из стартового `useState(false)`,
 * а спрашивал об этом четвёртым шагом общей цепочки — после `ipfsId()` и после
 * `runSyncIfOnline()`, то есть после похода в сеть. Плюс `hasStoredMnemonic`
 * умеет бросать: `readSeedRecord` намеренно пробрасывает всё, кроме
 * `SecureStoreUnreadableError` («Keystore заперт» — не «запись испорчена»).
 * Ловушки у ветки не было, поэтому бросок оставлял «не найдены» навсегда и
 * обрывал чтение имени, аватара, «О себе», @имени и счётчиков.
 *
 * Цена. Текст зовёт к действию, а «Создать новый аккаунт» пишет новую фразу и
 * новую пару ключей поверх прежних. Прежний кошелёк и привязанная к нему
 * переписка не возвращаются ничем — ровно та потеря, ради которой в ядре
 * писали v4.32.615 и v4.32.717.
 *
 * Правка. Четыре состояния вместо двух, отдельная ветка эффекта со своей
 * ловушкой, и на «не ответило» — свой текст, который прямо запрещает то, к
 * чему звал прежний.
 *
 * Границы. Проверенная пустота названа теми же словами, что и раньше.
 *
 * Модуль правки подтягивается внутри проверок, а не сверху файла: иначе на
 * коде до правки падал бы весь набор, включая контрольные.
 */

import { readFileSync } from 'fs';
import { join } from 'path';

type SeedPresence = 'asking' | 'yes' | 'no' | 'unknown';

const SRC = join(__dirname, '..', '..', '..');
const read = (p: string): string => readFileSync(join(SRC, p), 'utf8');

/** Пины ищут вызов, а не слово: собственный пояснительный комментарий их бы устроил. */
function codeOnly(src: string): string {
  return src
    .split('\n')
    .filter((l) => {
      const t = l.trim();
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
    })
    .join('\n');
}

const SCREEN = read('ui/screens/ProfileScreen.tsx');
const SEED = read('core/backup/seedPhrase.ts');

describe('«не ответило» больше не выдаётся за «не найдены»', () => {
  it('до ответа экран молчит, а не пугает', async () => {
    const { seedWarningText } = await import('../seedPresence');
    expect(seedWarningText('asking')).toBeNull();
    expect(SCREEN).toContain("useState<SeedPresence>('asking')");
  });

  it('отказ хранилища ключей получает свой, отдельный текст', async () => {
    const { seedWarningText, SEED_UNKNOWN_TEXT, SEED_ABSENT_TEXT } = await import('../seedPresence');
    expect(seedWarningText('unknown')).toBe(SEED_UNKNOWN_TEXT);
    expect(SEED_UNKNOWN_TEXT).not.toBe(SEED_ABSENT_TEXT);
  });

  it('этот текст прямо запрещает то, к чему звал прежний', async () => {
    const { SEED_UNKNOWN_TEXT, SEED_ABSENT_TEXT } = await import('../seedPresence');
    expect(SEED_ABSENT_TEXT).toContain('пройдите настройку заново');
    expect(SEED_UNKNOWN_TEXT).toContain('настройку заново проходить не нужно');
    expect(SEED_UNKNOWN_TEXT).toContain('не значит, что их нет');
  });

  it('бросок хранилища ключей ловится и превращается в «не знаем»', () => {
    expect(SCREEN).toContain("if (alive) setHasSeed('unknown');");
    expect(SCREEN).toContain("log.warn('profile_seed_presence_unknown'");
    expect(SCREEN).toContain('{seedWarningText(hasSeed) ? (');
  });

  it('вопрос задаётся своей веткой, а не за походом в сеть', () => {
    const body = codeOnly(SCREEN);
    const ask = body.indexOf('await hasStoredMnemonic()');
    const net = body.indexOf('await runSyncIfOnline()');
    expect(ask).toBeGreaterThan(-1);
    expect(net).toBeGreaterThan(-1);
    expect(ask).toBeLessThan(net);
  });

  it('ответ больше не ставится в размонтированный экран', () => {
    expect(codeOnly(SCREEN)).not.toContain('setHasSeed(await hasStoredMnemonic());');
    expect(SCREEN).toContain("if (alive) setHasSeed(has ? 'yes' : 'no');");
  });

  it('проверенная пустота названа прежними словами, слово в слово', async () => {
    const { seedWarningText, SEED_ABSENT_TEXT } = await import('../seedPresence');
    expect(seedWarningText('no')).toBe(SEED_ABSENT_TEXT);
    expect(SEED_ABSENT_TEXT).toBe(
      'Секретные слова на этом устройстве не найдены — при необходимости пройдите настройку заново.',
    );
    expect(seedWarningText('yes')).toBeNull();
  });

  it('все четыре состояния разобраны', async () => {
    const { seedWarningText, SEED_ABSENT_TEXT, SEED_UNKNOWN_TEXT } = await import('../seedPresence');
    const all: SeedPresence[] = ['asking', 'yes', 'no', 'unknown'];
    expect(all.map(seedWarningText)).toEqual([null, null, SEED_ABSENT_TEXT, SEED_UNKNOWN_TEXT]);
  });
});

describe('ПОВОД ДЛЯ ПРАВКИ ЖИВ', () => {
  it('чтение записи по-прежнему пробрасывает всё, кроме «запись испорчена»', () => {
    expect(SEED).toContain('if (!isSecureStoreUnreadable(e)) throw e;');
  });

  it('ядро по-прежнему считает «есть, но не открылась» наличием', () => {
    expect(SEED).toContain('v4.32.717');
    expect(SEED).toContain('if (encPresent) return true;');
  });

  it('предупреждение по-прежнему живёт рядом с кнопкой сохранения копии', () => {
    expect(SCREEN).toContain('Сохранить зашифрованную копию');
    expect(SCREEN).toContain('styles.warn');
  });

  it('та же ветка эффекта по-прежнему читает и остальную карточку', () => {
    expect(SCREEN).toContain('const savedAvatar = await ownAvatarUri();');
    expect(SCREEN).toContain("await ownFieldGet('user_bio')");
  });
});
