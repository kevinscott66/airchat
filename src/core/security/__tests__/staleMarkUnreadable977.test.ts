/**
 * Нечитаемая подсказка о запертой копии (v4.32.977).
 *
 * Дефект. Обе подсказки — конверт со словами у Apple ID и архив в облаке —
 * читались `scopedKvGet`, а он складывает три ответа хранилища в два:
 * «ячейки нет» и «прочитать не смогли» приходят одинаковым `null`
 * (`profileScopedKv`: `return (await scopedKvTryGetFor(pid, key))?.value ?? null;`).
 * Разбор же читает всё незнакомое как «копии не было». Значит, при отказе
 * базы обе пометки отвечали `'not_bound'` — «предупреждать не о чем», — а
 * исход `'unknown'`, ради которого `staleMark` заведён и который экран
 * настроек разбирает отдельной веткой, не наступал никогда. `try/catch`
 * вокруг чтения ловил только бросок разбора: само чтение не бросает.
 *
 * Цена. Человек меняет пароль приложения в момент, когда база занята. Ключ
 * обеих копий выводится из пароля, то есть обе перестали открываться, — но
 * приложение молчит, а настройки по-прежнему показывают привязку живой.
 * Проверяются копии ровно один раз: на новом телефоне, когда старого уже
 * нет. Там отказ необратим, а слов человек не сохранял — он был уверен, что
 * запасной путь есть.
 *
 * Правка. Обе подсказки читаются `scopedKvTryGet`, и «не прочитали» —
 * отдельный ответ: `'unknown'` у пометки, `null` у чтения (последнее давно
 * обещано её же докблоком). Дальше исход разбирает экран: он берёт в
 * свидетели то, что сам показывал человеку до смены пароля.
 *
 * Границы. Поверх непрочитанного ничего не пишется — ни в одном из случаев:
 * пометка «устарела» затёрла бы живое «привязана» ровно так же, как раньше
 * молчание. Бросок (его может дать разбор) по-прежнему даёт тот же исход.
 */
import fs from 'fs';
import path from 'path';

import {
  APPLE_BINDING_HINT_KEY,
  markAppleBindingStale,
} from '../appleBindingStale';
import { APPLE_BINDING_STORED } from '../appleBindingHint';
import {
  CLOUD_VAULT_COPY_KEY,
  CLOUD_VAULT_COPY_STORED,
  markCloudVaultCopyStale,
  readCloudVaultCopy,
} from '../../backup/cloudVaultCopy';
import { markPasswordBoundCopiesStale, passwordChangeAftermathText } from '../passwordChangeAftermath';
import { scopedKvGet, scopedKvSetChecked, scopedKvTryGet } from '../../storage/profileScopedKv';

/**
 * Хранилище одно, форм чтения две — как в `profileScopedKv`: складывающая
 * `scopedKvGet` там и написана поверх `scopedKvTryGet`. Мок повторяет это
 * буквально, иначе проверка мерила бы не правку, а отсутствующий в моке
 * метод: до правки модули звали именно складывающую форму.
 */
let stored: Record<string, string | null> | null = {};

const kvTry = scopedKvTryGet as jest.MockedFunction<typeof scopedKvTryGet>;
const kvFlat = scopedKvGet as jest.MockedFunction<typeof scopedKvGet>;
const kvSet = scopedKvSetChecked as jest.MockedFunction<typeof scopedKvSetChecked>;

jest.mock('../../storage/profileScopedKv', () => ({
  scopedKvTryGet: jest.fn(),
  scopedKvGet: jest.fn(),
  scopedKvSetChecked: jest.fn(),
}));

/** «Прочитали, и там лежит вот это» — по ключу, копии-то две. */
function answers(map: Record<string, string | null>): void {
  stored = map;
}

/** «Прочитать не смогли» — тот самый ответ, которого прежде не было видно. */
function unreadable(): void {
  stored = null;
}

const SRC = path.join(__dirname, '..', '..', '..');
const read = (...p: string[]): string => fs.readFileSync(path.join(SRC, ...p), 'utf8');

/** Только код: пересказ в комментарии не должен закрывать закрепку. */
function codeOnly(src: string): string {
  return src
    .split('\n')
    .filter((l) => {
      const t = l.trim();
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
    })
    .join('\n');
}

beforeEach(() => {
  stored = {};
  kvTry.mockReset();
  kvFlat.mockReset();
  kvSet.mockReset();
  kvTry.mockImplementation(async (key: string) => (stored ? { value: stored[key] ?? null } : null));
  kvFlat.mockImplementation(async (key: string) => (stored ? (stored[key] ?? null) : null));
  kvSet.mockResolvedValue(true);
});

describe('подсказку не прочитали', () => {
  it('привязка к Apple ID: это не «привязки не было»', async () => {
    unreadable();
    await expect(markAppleBindingStale()).resolves.toBe('unknown');
  });

  it('копия в облаке: это не «копии не было»', async () => {
    unreadable();
    await expect(markCloudVaultCopyStale()).resolves.toBe('unknown');
  });

  it('чтение подсказки о копии отвечает молчанием, как обещает её докблок', async () => {
    unreadable();
    await expect(readCloudVaultCopy()).resolves.toBeNull();
  });

  it('обе копии разом — и ни одного броска наружу', async () => {
    unreadable();
    await expect(markPasswordBoundCopiesStale()).resolves.toEqual({
      apple: 'unknown',
      cloud: 'unknown',
    });
  });

  it('ГРАНИЦА: поверх непрочитанного ничего не пишется', async () => {
    unreadable();
    await markPasswordBoundCopiesStale();
    expect(kvSet).not.toHaveBeenCalled();
  });

  it('ГРАНИЦА: своего текста у «неизвестно» нет — свидетеля ищет экран', async () => {
    unreadable();
    expect(passwordChangeAftermathText(await markPasswordBoundCopiesStale())).toBeNull();
  });
});

describe('ПРОВЕРКА НЕ ПУСТАЯ', () => {
  it('прочитали, а ячейки нет — по-прежнему «метить нечего»', async () => {
    answers({});
    await expect(markPasswordBoundCopiesStale()).resolves.toEqual({
      apple: 'not_bound',
      cloud: 'not_bound',
    });
    expect(kvSet).not.toHaveBeenCalled();
  });

  it('обе копии живы — обе помечаются и обе названы человеку', async () => {
    answers({
      [APPLE_BINDING_HINT_KEY]: APPLE_BINDING_STORED.bound,
      [CLOUD_VAULT_COPY_KEY]: CLOUD_VAULT_COPY_STORED.uploaded,
    });
    const report = await markPasswordBoundCopiesStale();
    expect(report).toEqual({ apple: 'marked', cloud: 'marked' });
    expect(kvSet).toHaveBeenCalledWith(APPLE_BINDING_HINT_KEY, APPLE_BINDING_STORED.stale);
    expect(kvSet).toHaveBeenCalledWith(CLOUD_VAULT_COPY_KEY, CLOUD_VAULT_COPY_STORED.stale);
    expect(passwordChangeAftermathText(report)).toContain('Apple ID');
  });

  it('прочитали, но запись не легла — это «не легло», а не «неизвестно»', async () => {
    answers({
      [APPLE_BINDING_HINT_KEY]: APPLE_BINDING_STORED.bound,
      [CLOUD_VAULT_COPY_KEY]: CLOUD_VAULT_COPY_STORED.uploaded,
    });
    kvSet.mockResolvedValue(false);
    await expect(markPasswordBoundCopiesStale()).resolves.toEqual({
      apple: 'unwritten',
      cloud: 'unwritten',
    });
  });

  it('уже помеченную копию второй раз не метят', async () => {
    answers({
      [APPLE_BINDING_HINT_KEY]: APPLE_BINDING_STORED.stale,
      [CLOUD_VAULT_COPY_KEY]: CLOUD_VAULT_COPY_STORED.stale,
    });
    await expect(markPasswordBoundCopiesStale()).resolves.toEqual({
      apple: 'not_bound',
      cloud: 'not_bound',
    });
    expect(kvSet).not.toHaveBeenCalled();
  });
});

describe('ПОВОД ДЛЯ ПРАВКИ ЖИВ', () => {
  it('scopedKvGet по-прежнему складывает три ответа в два', () => {
    expect(codeOnly(read('core', 'storage', 'profileScopedKv.ts'))).toContain(
      'return (await scopedKvTryGetFor(pid, key))?.value ?? null;',
    );
  });

  it('разбор подсказки читает всё незнакомое как «копии не было»', () => {
    const apple = codeOnly(read('core', 'security', 'appleBindingHint.ts'));
    const cloud = codeOnly(read('core', 'backup', 'cloudVaultCopy.ts'));
    expect(apple).toContain("return 'none';");
    expect(cloud).toContain("return 'none';");
  });

  it('экран настроек держит запасного свидетеля именно на «неизвестно»', () => {
    const settings = codeOnly(read('ui', 'screens', 'SettingsScreen.tsx'));
    expect(settings).toContain("const apple = report.apple !== 'unknown'");
    expect(settings).toContain("const cloud = report.cloud !== 'unknown'");
  });

  it('копии проверяются один раз и на чужом телефоне — отказ там необратим', () => {
    expect(codeOnly(read('core', 'backup', 'cloudVault.ts'))).toContain(
      'const seedKey = deriveLocalDekFromMnemonic(mnemonic);',
    );
  });
});

describe('ЗАКРЕПКА', () => {
  it('обе подсказки читаются формой, которая различает нечитаемость', () => {
    for (const src of [
      codeOnly(read('core', 'security', 'appleBindingStale.ts')),
      codeOnly(read('core', 'backup', 'cloudVaultCopy.ts')),
    ]) {
      expect(src).toContain('scopedKvTryGet(');
      expect(src).not.toContain('scopedKvGet(');
    }
  });
});
