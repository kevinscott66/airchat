/**
 * v4.32.864. В настройках два счётчика склоняли слово сами.
 *
 * Дефект. Подписи «N шаблонов» и «N устройств» выбирали окончание записью
 * `n === 1 ? … : n < 5 ? … : …`. Это сокращение правила: оно совпадает с ним
 * на 1–4 и расходится дальше. Двадцать один шаблон подписывался «21
 * шаблонов», двадцать два устройства — «22 устройств», одиннадцать — верно
 * только случайно.
 *
 * Цена. Обе подписи человек видит не в редком углу, а в первом же списке
 * настроек, и второй десяток у быстрых ответов — обычное дело.
 *
 * Правка. Оба места зовут общее правило. Сторож копий при этом искал
 * объявление функции — `function …plural…(` — и тернарник, написанный прямо
 * в разметке, объявлением не был: эти два прожили мимо него. Поэтому
 * расширен и сторож (см. core/__tests__/ruPlural.test.ts), иначе третья
 * копия появилась бы тем же способом.
 *
 * Проверяется исходник: экран настроек в jest не поднимается, а вся суть — в
 * том, какая запись выбирает форму. Само правило проверяется работой.
 */
import * as fs from 'fs';
import * as path from 'path';

import { pluralRu } from '../../../core/storage/ruPlural';

const SRC = path.join(__dirname, '..', '..', '..');
const read = (...rel: string[]): string => fs.readFileSync(path.join(SRC, ...rel), 'utf8');

/** Код без комментариев: пояснение не должно подменять проверку. */
function codeOnly(text: string): string {
  return text
    .split('\n')
    .filter((l) => {
      const t = l.trim();
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
    })
    .join('\n');
}

const SETTINGS = (): string => codeOnly(read('ui', 'screens', 'SettingsScreen.tsx'));
const GUARD = (): string => read('core', '__tests__', 'ruPlural.test.ts');

describe('ПРОВЕРКА НЕ ПУСТАЯ', () => {
  it('обе подписи на месте — есть что склонять', () => {
    const src = SETTINGS();
    expect(src).toContain('label="Быстрые ответы"');
    expect(src).toContain('<Text style={styles.label}>Активные сессии</Text>');
    expect(src).toContain('quickReplies.length > 0');
    expect(src).toContain('syncDevices.length > 0');
  });
});

describe('ПОВОД ДЛЯ ПРАВКИ ЖИВ', () => {
  it('сокращение расходится с правилом ровно там, где человек это видит', () => {
    // Если бы «n < 5» было верным, правка не значила бы ничего.
    const short = (n: number, one: string, few: string, many: string): string =>
      n === 1 ? one : n < 5 ? few : many;
    for (const n of [21, 22, 23, 101, 102]) {
      expect(pluralRu(n, 'шаблон', 'шаблона', 'шаблонов')).not.toBe(short(n, 'шаблон', 'шаблона', 'шаблонов'));
    }
    // На 1–4 и 11–14 они совпадают: тем дефект и жил.
    for (const n of [1, 2, 4, 11, 12]) {
      expect(pluralRu(n, 'шаблон', 'шаблона', 'шаблонов')).toBe(short(n, 'шаблон', 'шаблона', 'шаблонов'));
    }
  });

  it('сторож копий по-прежнему ловит объявления — расширение его не подменило', () => {
    expect(GUARD()).toContain('const DEFINES = /function\\s+\\w*[Pp]lural\\w*\\s*\\(/;');
  });
});

describe('форму выбирает общее правило', () => {
  it('быстрые ответы считают шаблоны им', () => {
    expect(SETTINGS()).toContain(
      "`${quickReplies.length} ${pluralRu(quickReplies.length, 'шаблон', 'шаблона', 'шаблонов')}`",
    );
  });

  it('активные сессии считают устройства им же', () => {
    expect(SETTINGS()).toContain(
      "`${syncDevices.length} ${pluralRu(syncDevices.length, 'устройство', 'устройства', 'устройств')}`",
    );
  });

  it('правило берётся из общего модуля, а не переписано рядом', () => {
    expect(SETTINGS()).toContain("import { pluralRu } from '../../core/storage/ruPlural';");
    expect(SETTINGS()).not.toMatch(/function\s+\w*[Pp]lural\w*\s*\(/);
  });

  it('сокращённой записи на экране настроек больше нет ни одной', () => {
    expect(SETTINGS()).not.toMatch(/<\s*5\s*\?\s*'/);
  });

  it('формы взяты правильные — подпись читается на любом числе', () => {
    expect(`${21} ${pluralRu(21, 'шаблон', 'шаблона', 'шаблонов')}`).toBe('21 шаблон');
    expect(`${22} ${pluralRu(22, 'шаблон', 'шаблона', 'шаблонов')}`).toBe('22 шаблона');
    expect(`${25} ${pluralRu(25, 'шаблон', 'шаблона', 'шаблонов')}`).toBe('25 шаблонов');
    expect(`${22} ${pluralRu(22, 'устройство', 'устройства', 'устройств')}`).toBe('22 устройства');
    expect(`${11} ${pluralRu(11, 'устройство', 'устройства', 'устройств')}`).toBe('11 устройств');
  });
});

describe('третья копия тем же способом не появится', () => {
  it('сторож смотрит и на тернарник в разметке, а не только на объявление', () => {
    const guard = GUARD();
    const at = guard.indexOf('const SHORTCUT =');
    expect(at).toBeGreaterThan(0);
    expect(guard).toContain('expect(shortcuts).toEqual([]);');
    // Правило структурное: сравнение с пятёркой, выбирающее между русскими
    // словами. Арифметику с числами (theme.ts) оно не трогает — там кавычек нет.
    expect(guard.slice(at, at + 200)).toContain("\\?\\s*'");
  });
});
