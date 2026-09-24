/**
 * v4.32.868. Сброс пароля по 24 словам не помечал привязку к Apple ID
 * устаревшей.
 *
 * Дефект. Конверт со словами лежит на сервере, зашифрованный паролем на момент
 * привязки (`putSeedBinding` → `encryptSeedBinding(mnemonic, password)`).
 * Сменили пароль — конверт новым не откроется, и ровно затем в v4.32.615
 * завели третье состояние подсказки: `stale`. Ставил его только экран
 * настроек, у себя внутри. Второй путь смены пароля — «забыл пароль →
 * восстановил по словам → задал новый» — шёл мимо: подсказка оставалась
 * `bound`.
 *
 * Цена. Настройки продолжали обещать запасной путь, которого уже нет, и
 * обещание это проверяется ровно один раз — на новом телефоне, когда слов на
 * руках нет. Пришедший по нему человек получает «Слова привязаны к Apple ID»,
 * вход через Apple, конверт с сервера — и отказ расшифровки. Хуже, чем
 * отсутствие привязки: на неё рассчитывали.
 *
 * Правка. Чтение подсказки, решение и запись переехали в ядро
 * (`markAppleBindingStale`), и оба пути смены пароля зовут одно и то же.
 * Модуль отвечает исходом, а не броском: пароль к моменту вызова уже сменён,
 * ронять сделанную работу на подсказке нельзя, а соврать про неё — тем более.
 *
 * Правило здесь структурное: не «в этих двух местах есть вызов», а «за каждой
 * сменой пароля он стоит». Третий путь, если заведётся, спросят так же.
 */
import fs from 'fs';
import path from 'path';

import {
  APPLE_BINDING_STORED,
  hintAfterPasswordChange,
} from '../../../core/security/appleBindingHint';
import {
  APPLE_BINDING_HINT_KEY,
  APPLE_BINDING_STALE_TEXT,
  markAppleBindingStale,
} from '../../../core/security/appleBindingStale';
import { scopedKvGet, scopedKvSetChecked } from '../../../core/storage/profileScopedKv';

jest.mock('../../../core/storage/profileScopedKv', () => ({
  scopedKvGet: jest.fn(),
  scopedKvSetChecked: jest.fn(),
}));

const kvGet = scopedKvGet as jest.MockedFunction<typeof scopedKvGet>;
const kvSet = scopedKvSetChecked as jest.MockedFunction<typeof scopedKvSetChecked>;

const SRC = path.join(__dirname, '..', '..', '..');
const read = (...p: string[]): string => fs.readFileSync(path.join(SRC, ...p), 'utf8');

/** Только код: пояснения не должны сами удовлетворять проверку. */
function codeOnly(src: string): string {
  return src
    .split('\n')
    .filter((l) => {
      const t = l.trim();
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
    })
    .join('\n');
}

/** Все исходники приложения, кроме тестов: правило ниже общее для всех. */
function sources(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name !== '__tests__' && e.name !== 'node_modules') sources(full, out);
    } else if (/\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) {
      out.push(full);
    }
  }
  return out;
}

const FORGOT = (): string => codeOnly(read('ui', 'screens', 'ForgotPasswordScreen.tsx'));
const SETTINGS = (): string => codeOnly(read('ui', 'screens', 'SettingsScreen.tsx'));

beforeEach(() => {
  kvGet.mockReset();
  kvSet.mockReset();
});

describe('ПРОВЕРКА НЕ ПУСТАЯ', () => {
  it('исходники читаются и оба экрана смены пароля на месте', () => {
    expect(FORGOT()).toContain('authGuard.resetPasswordWithVerifiedSeed(m, newPassword)');
    expect(SETTINGS()).toContain('authGuard.changePassword(oldPwd, newPwd)');
    expect(sources(SRC).length).toBeGreaterThan(100);
  });
});

describe('ПОВОД ДЛЯ ПРАВКИ ЖИВ', () => {
  it('конверт на сервере по-прежнему заперт паролем, а не словами', () => {
    const binding = codeOnly(read('core', 'backup', 'seedBinding.ts'));
    expect(binding).toContain('const envelope = encryptSeedBinding(mnemonic, password);');
    // Перешифровать молча нечем: нужен свежий токен Apple, то есть окно.
    expect(binding).toContain('idToken: string,');
  });

  it('правило «сменили пароль — привязка устарела» старше правки', () => {
    expect(hintAfterPasswordChange('bound')).toBe('stale');
    expect(hintAfterPasswordChange('stale')).toBeNull();
    expect(hintAfterPasswordChange('none')).toBeNull();
  });
});

describe('ядро отвечает исходом, а не броском', () => {
  it('привязка живая — помечает и говорит «пометили»', async () => {
    kvGet.mockResolvedValue(APPLE_BINDING_STORED.bound);
    kvSet.mockResolvedValue(true);
    await expect(markAppleBindingStale()).resolves.toBe('marked');
    expect(kvSet).toHaveBeenCalledWith(APPLE_BINDING_HINT_KEY, APPLE_BINDING_STORED.stale);
  });

  it('привязки нет или она уже помечена — не пишет вовсе', async () => {
    for (const stored of [APPLE_BINDING_STORED.none, APPLE_BINDING_STORED.stale, null]) {
      kvGet.mockResolvedValue(stored);
      await expect(markAppleBindingStale()).resolves.toBe('not_bound');
    }
    expect(kvSet).not.toHaveBeenCalled();
  });

  it('база ответила «не легло» — так и сказано, отдельным словом', async () => {
    kvGet.mockResolvedValue(APPLE_BINDING_STORED.bound);
    kvSet.mockResolvedValue(false);
    await expect(markAppleBindingStale()).resolves.toBe('unwritten');
  });

  it('запись бросила — тоже «не легло», и наружу бросок не уходит', async () => {
    kvGet.mockResolvedValue(APPLE_BINDING_STORED.bound);
    kvSet.mockRejectedValue(new Error('database is locked'));
    await expect(markAppleBindingStale()).resolves.toBe('unwritten');
  });

  it('чтение бросило — «неизвестно»: гадать за вызывающего нечем', async () => {
    kvGet.mockRejectedValue(new Error('database is locked'));
    await expect(markAppleBindingStale()).resolves.toBe('unknown');
    expect(kvSet).not.toHaveBeenCalled();
  });

  it('два исхода из четырёх имеют текст для человека, и разный', () => {
    expect(Object.keys(APPLE_BINDING_STALE_TEXT).sort()).toEqual(['marked', 'unwritten']);
    expect(APPLE_BINDING_STALE_TEXT.marked).not.toBe(APPLE_BINDING_STALE_TEXT.unwritten);
    // «Не легло» обязано сказать, что настройки соврут после перезапуска.
    expect(APPLE_BINDING_STALE_TEXT.unwritten).toContain('после перезапуска');
  });
});

describe('за каждой сменой пароля стоит пометка', () => {
  it('ни один вызов смены пароля не обходится без неё', () => {
    // Структурно: `changePassword` и `resetPasswordWithVerifiedSeed` меняют
    // пароль у живого аккаунта — значит, запирают конверт. `setPassword`
    // правилом не покрыт: он ставит первый пароль, а без пароля привязки и
    // быть не может (кнопка привязки закрыта `hasAppPassword`).
    const CHANGERS = /authGuard\.(changePassword|resetPasswordWithVerifiedSeed)\(/g;
    let seen = 0;
    for (const file of sources(SRC)) {
      const src = codeOnly(fs.readFileSync(file, 'utf8'));
      for (const m of src.matchAll(CHANGERS)) {
        seen += 1;
        const at = m.index ?? 0;
        expect([file, src.slice(at, at + 900).includes('markAppleBindingStale')]).toEqual([file, true]);
      }
    }
    expect(seen).toBe(2);
  });

  it('первый пароль под правило не попадает — и закрыт проверкой «уже стоит»', () => {
    const body = SETTINGS().slice(SETTINGS().indexOf('const submitSetPassword'), SETTINGS().indexOf('const submitChangePassword'));
    expect(body).toContain('already = await authGuard.hasPassword();');
    expect(body).toContain("if (already) {");
    expect(body).not.toContain('markAppleBindingStale');
  });
});

describe('сброс по словам говорит человеку правду', () => {
  it('пометка стоит после удачного сброса и до выхода с экрана', () => {
    const forgot = FORGOT();
    const reset = forgot.indexOf('const ok = await authGuard.resetPasswordWithVerifiedSeed(m, newPassword);');
    const mark = forgot.indexOf('const stale = await markAppleBindingStale();');
    const leave = forgot.indexOf('onSuccess();');
    expect(reset).toBeGreaterThan(0);
    expect(mark).toBeGreaterThan(reset);
    expect(leave).toBeGreaterThan(mark);
    // Неудачный сброс до пометки не доходит: пароль не менялся, конверт цел.
    expect(forgot.slice(reset, mark)).toContain("showError('Не удалось сохранить пароль');");
  });

  it('текст берётся общий, свой на экране не заведён', () => {
    for (const src of [FORGOT(), SETTINGS()]) {
      expect(src).toContain('APPLE_BINDING_STALE_TEXT[');
      expect(src).not.toContain('Привязка к Apple ID больше не откроется');
    }
  });

  it('«неизвестно» на этом экране молчит: свидетеля тут нет', () => {
    const forgot = FORGOT();
    expect(forgot).toContain(
      "if (stale === 'marked' || stale === 'unwritten') showError(APPLE_BINDING_STALE_TEXT[stale]);",
    );
    expect(forgot).not.toContain("stale === 'unknown'");
  });

  it('ключ подсказки один на приложение — переехал, а не размножился', () => {
    const holders = sources(SRC).filter((f) =>
      fs.readFileSync(f, 'utf8').includes("'apple_seed_binding_v1'"),
    );
    expect(holders.map((f) => path.relative(SRC, f))).toEqual([
      path.join('core', 'security', 'appleBindingStale.ts'),
    ]);
  });
});
