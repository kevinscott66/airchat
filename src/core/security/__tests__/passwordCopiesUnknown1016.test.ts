/**
 * О непрочитанной подсказке не говорили вовсе (v4.32.1016).
 *
 * Дефект. `passwordChangeAftermathText` строил строку только на `'marked'` и
 * `'unwritten'`. Исход `'unknown'` — «подсказку прочитать не вышло» — не давал
 * строки ни одной, и довод стоял такой: свидетеля ищет экран. Свидетелей на
 * деле два, и оба не работают. У сброса пароля по секретным словам его нет
 * вовсе: `ForgotPasswordScreen` отдаёт отчёт в разбор как есть. А у настроек
 * он приходит из той же базы, которая только что отказала ядру: `appleBound`
 * начинается с `false`, `cloudCopy` — с `null`, и оба читались как «копии не
 * было». Одна занятая база давала сразу и `'unknown'` от ядра, и молчание
 * свидетеля. Сверх того, чтение подсказки на экране шло `scopedKvGet` —
 * формой, которая отказ базы и пустую ячейку складывает в один `null`, — и
 * стояло ПОСЛЕ похода на сервер за списком провайдеров: бросок оттуда уносил
 * чтение целиком.
 *
 * Цена. `'unknown'` значит, что пометка не легла. На диске осталось прежнее
 * «привязаны»/«копия отправлена», и настройки будут обещать запасной путь и
 * завтра, и через год: поправить их было нечем, а второй попытки никто не
 * делает. Ключ обеих копий выведен из пароля, пароль сменился — обе заперты.
 * Проверяются они ровно один раз: на новом телефоне, когда старого уже нет.
 * Там отказ необратим. Расчёт «настройки покажут состояние сами» был ровно
 * наоборот: показывать они будут именно то, что не успели поправить.
 *
 * Правка. У `'unknown'` теперь свой текст — обе половины названы: проверить не
 * вышло; если копия была, новым паролем она не откроется. Свидетелю на экране
 * разрешено не знать: подсказка держит четвёртое состояние, читается формой,
 * различающей нечитаемость, и читается до сервера, а не после.
 *
 * Границы. `'not_bound'` по-прежнему молчит: пугать копией, которой не было,
 * незачем. Поверх непрочитанного по-прежнему ничего не пишется. В настройках
 * строка «Привязка к Apple ID устарела» встаёт только когда пометка и правда
 * легла или правда не легла, — про непрочитанное говорит текст, а не строка.
 */
import fs from 'fs';
import path from 'path';

import { APPLE_BINDING_STALE_TEXT, markAppleBindingStale, APPLE_BINDING_HINT_KEY } from '../appleBindingStale';
import { APPLE_BINDING_STORED } from '../appleBindingHint';
import {
  CLOUD_VAULT_COPY_KEY,
  CLOUD_VAULT_COPY_STORED,
  CLOUD_VAULT_STALE_TEXT,
} from '../../backup/cloudVaultCopy';
import { markPasswordBoundCopiesStale, passwordChangeAftermathText } from '../passwordChangeAftermath';
import { scopedKvGet, scopedKvSetChecked, scopedKvTryGet } from '../../storage/profileScopedKv';

/** Хранилище одно, форм чтения две — буквально как в `profileScopedKv`. */
let stored: Record<string, string | null> | null = {};

const kvTry = scopedKvTryGet as jest.MockedFunction<typeof scopedKvTryGet>;
const kvFlat = scopedKvGet as jest.MockedFunction<typeof scopedKvGet>;
const kvSet = scopedKvSetChecked as jest.MockedFunction<typeof scopedKvSetChecked>;

jest.mock('../../storage/profileScopedKv', () => ({
  scopedKvTryGet: jest.fn(),
  scopedKvGet: jest.fn(),
  scopedKvSetChecked: jest.fn(),
}));

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

describe('о непрочитанной подсказке говорят', () => {
  it('привязка к Apple ID: строка есть, и она не пустая', () => {
    const text = passwordChangeAftermathText({ apple: 'unknown', cloud: 'not_bound' });

    expect(text).not.toBeNull();
    expect(text).toContain('Apple ID');
  });

  it('копия в облаке: строка есть, и она про облако', () => {
    const text = passwordChangeAftermathText({ apple: 'not_bound', cloud: 'unknown' });

    expect(text).not.toBeNull();
    expect(text).toContain('облаке');
  });

  it('названы обе половины: проверить не вышло — и чем это грозит', () => {
    const text = passwordChangeAftermathText({ apple: 'unknown', cloud: 'unknown' }) ?? '';

    // Первая половина: почему мы не знаем.
    expect(text).toContain('Привязку к Apple ID проверить не удалось');
    expect(text).toContain('Копию в облаке проверить не удалось');
    // Вторая: что теперь с копией и что делать прямо сейчас.
    expect(text).toContain('новым паролем');
    expect(text).toContain('Привяжите слова заново сейчас');
    expect(text).toContain('Отправьте копию заново сейчас');
  });

  it('обе копии разом — две строки, а не одна склеенная фраза', () => {
    const text = passwordChangeAftermathText({ apple: 'unknown', cloud: 'unknown' }) ?? '';

    expect(text.split('\n\n')).toHaveLength(2);
  });

  it('вся дорога от занятой базы до текста проходится целиком', async () => {
    stored = null;
    const report = await markPasswordBoundCopiesStale();

    expect(report).toEqual({ apple: 'unknown', cloud: 'unknown' });
    expect(passwordChangeAftermathText(report)).not.toBeNull();
  });

  it('у «неизвестно» текст свой, а не пересказ соседнего исхода', () => {
    for (const t of [APPLE_BINDING_STALE_TEXT, CLOUD_VAULT_STALE_TEXT]) {
      expect(typeof t.unknown).toBe('string');
      expect(t.unknown).toContain('проверить не удалось');
      expect(t.unknown).not.toBe(t.marked);
      expect(t.unknown).not.toBe(t.unwritten);
    }
  });
});

describe('ПРОВЕРКА НЕ ПУСТАЯ: прежние исходы говорят прежнее', () => {
  it('«пометили» и «не легло» — те же самые строки', () => {
    expect(passwordChangeAftermathText({ apple: 'marked', cloud: 'not_bound' })).toBe(
      APPLE_BINDING_STALE_TEXT.marked,
    );
    expect(passwordChangeAftermathText({ apple: 'not_bound', cloud: 'unwritten' })).toBe(
      CLOUD_VAULT_STALE_TEXT.unwritten,
    );
  });

  it('«не легло» по-прежнему предупреждает про перезапуск', () => {
    expect(APPLE_BINDING_STALE_TEXT.unwritten).toContain('после перезапуска');
    expect(CLOUD_VAULT_STALE_TEXT.unwritten).toContain('после перезапуска');
  });

  it('обе копии живы — обе помечаются и обе названы', async () => {
    stored = {
      [APPLE_BINDING_HINT_KEY]: APPLE_BINDING_STORED.bound,
      [CLOUD_VAULT_COPY_KEY]: CLOUD_VAULT_COPY_STORED.uploaded,
    };
    const report = await markPasswordBoundCopiesStale();

    expect(report).toEqual({ apple: 'marked', cloud: 'marked' });
    expect(passwordChangeAftermathText(report)).toContain('Apple ID');
  });

  it('ядро на нечитаемой подсказке по-прежнему отвечает словом, а не броском', async () => {
    stored = null;
    await expect(markAppleBindingStale()).resolves.toBe('unknown');
  });
});

describe('ГРАНИЦА: «копии не было» — по-прежнему молчание', () => {
  it('обе копии не заводили — показывать нечего', () => {
    expect(passwordChangeAftermathText({ apple: 'not_bound', cloud: 'not_bound' })).toBeNull();
  });

  it('уже помеченную копию второй раз не поминают', async () => {
    stored = {
      [APPLE_BINDING_HINT_KEY]: APPLE_BINDING_STORED.stale,
      [CLOUD_VAULT_COPY_KEY]: CLOUD_VAULT_COPY_STORED.stale,
    };
    const report = await markPasswordBoundCopiesStale();

    expect(report).toEqual({ apple: 'not_bound', cloud: 'not_bound' });
    expect(passwordChangeAftermathText(report)).toBeNull();
  });

  it('поверх непрочитанного ничего не пишется', async () => {
    stored = null;
    await markPasswordBoundCopiesStale();

    expect(kvSet).not.toHaveBeenCalled();
  });

});

describe('свидетелю на экране разрешено не знать', () => {
  const settings = (): string => codeOnly(read('ui', 'screens', 'SettingsScreen.tsx'));

  it('подсказка держит четвёртое состояние, а не два флажка с `false`', () => {
    expect(settings()).toContain(
      "const [appleHint, setAppleHint] = useState<AppleBindingHint | 'unknown'>('none');",
    );
  });

  it('оба свидетеля отвечают «не знаю», а не «копии не было»', () => {
    const s = settings();

    expect(s).toContain(": appleHint === 'unknown'");
    expect(s).toContain(': cloudCopy === null');
  });

  it('подсказку читают формой, различающей отказ базы и пустую ячейку', () => {
    const s = settings();

    expect(s).toContain('const cell = await scopedKvTryGet(APPLE_BINDING_HINT_KEY);');
    // Складывающей формы на экране не осталось вовсе.
    expect(s).not.toContain('scopedKvGet(');
  });

  it('строку «устарела» ставят только на состоявшуюся пометку', () => {
    // Сказать «привязка устарела» про привязку, о которой мы ничего не знаем,
    // значит соврать в другую сторону. Про непрочитанное говорит текст.
    const s = settings();

    expect(s).toContain("if (apple === 'marked' || apple === 'unwritten') setAppleHint('stale');");
    expect(s).toContain("if (cloud === 'marked' || cloud === 'unwritten') setCloudCopy('stale');");
  });

  it('подсказку читают до сервера: его отказ больше не уносит чтение', () => {
    const s = settings();
    const hint = s.indexOf('const cell = await scopedKvTryGet(APPLE_BINDING_HINT_KEY);');
    const providers = s.indexOf('providers = await listSeedBindingProviders();');

    expect(hint).toBeGreaterThan(-1);
    expect(providers).toBeGreaterThan(hint);
  });
});

describe('ПОВОД ДЛЯ ПРАВКИ ЖИВ', () => {
  it('у сброса пароля по словам свидетеля по-прежнему нет', () => {
    // Отчёт уходит в разбор как есть — значит молчание на `unknown` было бы
    // молчанием и здесь, чинить его свидетелем на другом экране нечем.
    expect(codeOnly(read('ui', 'screens', 'ForgotPasswordScreen.tsx'))).toContain(
      'const text = passwordChangeAftermathText(await markPasswordBoundCopiesStale());',
    );
  });

  it('`scopedKvGet` по-прежнему складывает три ответа хранилища в два', () => {
    expect(codeOnly(read('core', 'storage', 'profileScopedKv.ts'))).toContain(
      'return (await scopedKvTryGetFor(pid, key))?.value ?? null;',
    );
  });

  it('разбор подсказки по-прежнему читает всё незнакомое как «привязки не было»', () => {
    expect(codeOnly(read('core', 'security', 'appleBindingHint.ts'))).toContain("return 'none';");
  });

  it('пометка по-прежнему требует сперва прочитать: не прочитали — не записали', () => {
    const stale = codeOnly(read('core', 'security', 'appleBindingStale.ts'));
    const at = stale.indexOf('export async function markAppleBindingStale(');
    expect(at).toBeGreaterThan(-1);
    const body = stale.slice(at, at + 900);
    expect(body).toContain("return 'unknown';");
    expect(body.indexOf("return 'unknown';")).toBeLessThan(body.indexOf('scopedKvSetChecked('));
  });
});
