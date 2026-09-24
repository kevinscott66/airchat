/**
 * v4.32.880. «Вычисляется…» навсегда, а поверх — «Кэш очищен».
 *
 * Дефект. Размер кэша жил в одном числе с `null` вместо всего остального:
 * `null` означал и «ещё считаем», и «посчитать не вышло». Подпись выводилась
 * из него одной строкой — `cacheSize !== null ? formatByteSize(...) :
 * 'Вычисляется…'`. Отказ чтения папки (`catch { setCacheSize(null); }`) и
 * отсутствие самой папки (`if (!dir) return;`) оставляли «Вычисляется…» на
 * экране до конца жизни экрана.
 *
 * Цена. Человек заходит в настройки освободить место и видит вечное
 * «Вычисляется…»: сколько занято — неизвестно, стоит ли жать «Очистить» —
 * непонятно. Нажав, он получал «Кэш очищен» поверх всё того же
 * «Вычисляется…», то есть отчёт об успехе без единого подтверждения.
 *
 * Правка. У размера появилось положение: считаем, посчитали, не вышло.
 * Подпись — чистая функция от положения, и «не вышло» говорится словами.
 */
import fs from 'fs';
import path from 'path';
import {
  CACHE_SIZE_LOADING_TEXT,
  CACHE_SIZE_UNKNOWN_TEXT,
  cacheSizeLabel,
} from '../settings/settingsLabels';
import { formatByteSize } from '../../../core/media/byteSize';

const SCREENS = path.join(__dirname, '..');
const read = (rel: string): string => fs.readFileSync(path.join(SCREENS, rel), 'utf8');
/** Код без комментариев: слова из докблоков не должны считаться за проверку. */
const codeOnly = (src: string): string =>
  src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l.trim() ? l : ' ')).join('\n');

describe('v4.32.880 — размер кэша говорит правду', () => {
  describe('ПРОВЕРКА НЕ ПУСТАЯ (проходит и на старом коде)', () => {
    it('в настройках и правда есть размер кэша и кнопка очистки', () => {
      const src = codeOnly(read('SettingsScreen.tsx'));
      expect(src).toContain('const loadCacheSize = useCallback(');
      expect(src).toContain('const clearCache = useCallback(');
      expect(src).toContain("showSuccess('Кэш очищен')");
      expect(src).toContain('{cacheSizeLabel}');
    });

    it('размер считается обходом папки кэша — то есть может не посчитаться', () => {
      const src = codeOnly(read('SettingsScreen.tsx'));
      expect(src).toContain('FileSystem.cacheDirectory');
      expect(src).toContain('FileSystem.readDirectoryAsync(dir)');
    });
  });

  describe('ПОВОД ДЛЯ ПРАВКИ ЖИВ', () => {
    it('число байт по-прежнему печатается тем же форматированием', () => {
      expect(formatByteSize(0)).toEqual(expect.any(String));
      expect(cacheSizeLabel('ready', 1024)).toBe(formatByteSize(1024));
    });
  });

  describe('три положения вместо двух', () => {
    it('пока считаем — так и говорим', () => {
      expect(cacheSizeLabel('loading', null)).toBe(CACHE_SIZE_LOADING_TEXT);
      expect(cacheSizeLabel('loading', 123)).toBe(CACHE_SIZE_LOADING_TEXT);
    });

    it('посчитали — показываем число, даже нулевое', () => {
      expect(cacheSizeLabel('ready', 0)).toBe(formatByteSize(0));
      expect(cacheSizeLabel('ready', 5_242_880)).toBe(formatByteSize(5_242_880));
    });

    it('не вышло — говорим об этом, а не изображаем подсчёт', () => {
      expect(cacheSizeLabel('unknown', null)).toBe(CACHE_SIZE_UNKNOWN_TEXT);
      expect(cacheSizeLabel('unknown', null)).not.toBe(CACHE_SIZE_LOADING_TEXT);
    });

    it('«посчитали» без числа за число не выдаётся', () => {
      expect(cacheSizeLabel('ready', null)).toBe(CACHE_SIZE_UNKNOWN_TEXT);
    });

    it('обе надписи — по-русски и разные', () => {
      expect(CACHE_SIZE_LOADING_TEXT).not.toBe(CACHE_SIZE_UNKNOWN_TEXT);
      expect(CACHE_SIZE_UNKNOWN_TEXT).toMatch(/[а-яё]/i);
    });
  });

  describe('экран пользуется положением', () => {
    const src = codeOnly(read('SettingsScreen.tsx'));

    it('подпись больше не выводится из одного лишь null', () => {
      expect(src).not.toContain("cacheSize !== null ? formatByteSize(cacheSize) : 'Вычисляется…'");
      expect(src).toContain('cacheSizeText(cacheSizePhase, cacheSize)');
    });

    it('оба тупика подсчёта помечаются как «не вышло»', () => {
      expect(src).toContain("if (!dir) { setCacheSize(null); setCacheSizePhase('unknown'); return; }");
      expect(src).toContain("} catch { setCacheSize(null); setCacheSizePhase('unknown'); }");
      expect(src).toContain("setCacheSizePhase('ready');");
    });
  });
});
