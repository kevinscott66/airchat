/**
 * v4.32.882 — три окна настроек, которые молчали об отказе.
 *
 * Дефект: submitChangePassword, submitBackupUnlock и handleShowSeed были
 * написаны как try/finally без catch. Любой отказ ниже — хранилище, чтение
 * мнемоники, проверка пароля — уходил в необработанное отклонение промиса.
 * Видимый итог: кнопка переставала быть занятой, окно оставалось на месте,
 * не сказав ни слова.
 *
 * Цена: человек не знает, сменился ли пароль; жмёт «Разблокировать» ещё раз
 * и списывает попытки на пароле, который ни при чём; не увидев секретных
 * слов, решает, что их больше нет, и идёт восстанавливать кошелёк с нуля.
 *
 * Правка: у всех трёх появился catch с showError(userErrorText(e, …)) и
 * запасным текстом по-русски — как у submitBindApple, который в этом же
 * файле уже был написан правильно.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

const SRC = readFileSync(join(__dirname, '..', 'SettingsScreen.tsx'), 'utf8');

/** Только код: в комментариях можно написать что угодно. */
function codeOnly(src: string): string {
  return src
    .split('\n')
    .filter((l) => {
      const t = l.trim();
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
    })
    .join('\n');
}

const CODE = codeOnly(SRC);

/** Тело обработчика — от его объявления до конца его try/finally. */
function bodyOf(decl: string): string {
  const start = CODE.indexOf(decl);
  expect(start).toBeGreaterThan(0);
  const busyOff = CODE.indexOf('Busy(false); }', start);
  expect(busyOff).toBeGreaterThan(start);
  return CODE.slice(start, busyOff + 14);
}

const HANDLERS: readonly (readonly [string, string])[] = [
  ['смена пароля', 'const submitChangePassword = async ()'],
  ['разблокировка копии', 'const submitBackupUnlock = async ()'],
  ['показ секретных слов', 'const handleShowSeed = useCallback(async ()'],
];

describe('v4.32.882 — настройки называют отказ', () => {
  describe('ПРОВЕРКА НЕ ПУСТАЯ (проходит и на старом коде)', () => {
    it.each(HANDLERS)('%s — обработчик на месте и занимает кнопку', (_name, decl) => {
      const body = bodyOf(decl);
      expect(body).toContain('try {');
      expect(body).toMatch(/set\w+Busy\(true\)/);
      expect(body).toMatch(/set\w+Busy\(false\)/);
    });

    it('в файле есть правильный образец — submitBindApple', () => {
      expect(CODE).toContain("showError(userErrorText(e, 'Не удалось привязать секретные слова'))");
    });

    it('userErrorText уже был под рукой', () => {
      expect(CODE).toContain("from '../components/userErrorText'");
    });
  });

  describe('ПОВОД ДЛЯ ПРАВКИ ЖИВ', () => {
    it('ранние выходы по-прежнему отвечают своими словами, а не общим отказом', () => {
      const body = bodyOf('const submitBackupUnlock = async ()');
      expect(body).toContain("if (result === 'empty') { showError('Введите пароль'); return; }");
      expect(body).toContain('await showPasswordRejected()');
    });

    it('занятость снимается в finally, а не в catch', () => {
      for (const [, decl] of HANDLERS) {
        const body = bodyOf(decl);
        expect(body).toMatch(/\} finally \{ set\w+Busy\(false\); \}/);
      }
    });
  });

  describe('отказ виден человеку', () => {
    it.each(HANDLERS)('%s — ловит ошибку', (_name, decl) => {
      const body = bodyOf(decl);
      expect(body).toContain('} catch (e) {');
    });

    it.each(HANDLERS)('%s — показывает текст, а не молчит', (_name, decl) => {
      const body = bodyOf(decl);
      expect(body).toMatch(/showError\(userErrorText\(e, '[^']+'\)\)/);
    });

    it.each(HANDLERS)('%s — запасной текст по-русски и не пустой', (_name, decl) => {
      const body = bodyOf(decl);
      const m = /userErrorText\(e, '([^']+)'\)/.exec(body);
      expect(m).not.toBeNull();
      const fallback = m![1];
      expect(fallback.length).toBeGreaterThan(10);
      expect(fallback).toMatch(/[а-яё]/i);
    });

    it('у каждого окна свой текст — человек понимает, что именно не вышло', () => {
      const texts = HANDLERS.map(([, decl]) => /userErrorText\(e, '([^']+)'\)/.exec(bodyOf(decl))![1]);
      expect(new Set(texts).size).toBe(texts.length);
    });

    it('catch стоит до finally, иначе кнопка разблокируется раньше сообщения', () => {
      for (const [, decl] of HANDLERS) {
        const body = bodyOf(decl);
        // Без этой строки проверка прошла бы и на старом коде: у отсутствующего
        // catch indexOf равен -1, а -1 меньше чего угодно.
        expect(body).toContain('} catch (e) {');
        expect(body.indexOf('} catch (e) {')).toBeLessThan(body.indexOf('} finally {'));
      }
    });
  });
});
