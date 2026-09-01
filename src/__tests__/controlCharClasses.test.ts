/**
 * Один список управляющих символов на всё приложение (v4.32.369).
 *
 * Правило «вычисти управляющие символы из чужого имени» записано в
 * sysLineGuard, но было переписано от руки ещё в семи файлах: разбор
 * пригласительной ссылки, индекс контактов (дважды), баннер уведомления,
 * свой профиль, конверт профиля собеседника, имя присланного файла и id
 * цитаты. Все копии знали про диапазон C0 — и ни одна не знала, что разрыв
 * строки дают ещё три символа за его пределами: U+0085, U+2028 и U+2029.
 * Android и iOS ломают строку на каждом из них, то есть подделка системной
 * строки чужим именем работала в обход единственной защиты от неё.
 *
 * Проверить это на значениях нельзя: каждая копия — отдельный литерал в
 * отдельном файле, и написать седьмую ничего не мешает. Поэтому проверяем
 * исходники: если файл перечисляет управляющие символы сам, список обязан
 * быть полным.
 */

import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';

const SRC = join(__dirname, '..');

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === '__tests__' || name === 'node_modules') continue;
      walk(full, out);
    } else if (name.endsWith('.ts') || name.endsWith('.tsx')) {
      out.push(full);
    }
  }
  return out;
}

/** Классы символов, объявленные в исходнике от руки и начинающиеся с C0. */
export function controlClasses(source: string): string[] {
  return source.match(/\/\[[^\]\n]*\\u0000-\\u001[Ff][^\]\n]*\]/g) ?? [];
}

/**
 * Из них — неполные. Полный список обязан покрывать C1 (в нём U+0085) и оба
 * разделителя строки: без них перевод строки в имени проходит насквозь.
 */
export function incompleteControlClasses(source: string): string[] {
  return controlClasses(source).filter(
    (c) =>
      !(
        (c.includes('\\u007F-\\u009F') || c.includes('\\u0080-\\u009F')) &&
        c.includes('\\u2028') &&
        c.includes('\\u2029')
      )
  );
}

describe('перечисление управляющих символов в исходниках', () => {
  const files = walk(SRC);

  it('обход что-то находит', () => {
    expect(files.length).toBeGreaterThan(200);
  });

  it('проверка видит настоящие объявления, а не пустоту', () => {
    // Пустой список означал бы, что регулярка сломана и проверка молчит.
    const withClass = files.filter((f) => controlClasses(readFileSync(f, 'utf8')).length > 0);
    expect(withClass.length).toBeGreaterThanOrEqual(3);
    expect(withClass.some((f) => f.endsWith('sysLineGuard.ts'))).toBe(true);
  });

  it('все объявленные списки полные', () => {
    const offenders: string[] = [];
    for (const f of files) {
      for (const c of incompleteControlClasses(readFileSync(f, 'utf8'))) {
        offenders.push(`${f.slice(SRC.length + 1)}: ${c}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe('incompleteControlClasses', () => {
  it('список до 4.32.369 считается неполным', () => {
    const old = String.raw`.replace(/[\u0000-\u001F\u007F]/g, ' ')`;
    expect(incompleteControlClasses(old)).toHaveLength(1);
  });

  it('полный список проходит', () => {
    const now = String.raw`/[\u0000-\u001F\u007F-\u009F\u2028\u2029]/g`;
    expect(incompleteControlClasses(now)).toEqual([]);
  });

  it('C1 отдельным диапазоном тоже засчитывается', () => {
    const alt = String.raw`/[\u0000-\u001F\u007F\u0080-\u009F\u2028\u2029]/`;
    expect(incompleteControlClasses(alt)).toEqual([]);
  });

  it('класс без C0 — не наше дело', () => {
    // Такие списки решают другие задачи: например, вычистку меток направления
    // письма, где C0 ни при чём.
    expect(controlClasses(String.raw`/[\u202A-\u202E\uFEFF]/g`)).toEqual([]);
  });

  it('находит несколько объявлений в одном файле', () => {
    const src = String.raw`/[\u0000-\u001F\u007F]/g` + '\n' + String.raw`/[\u0000-\u001F]/g`;
    expect(incompleteControlClasses(src)).toHaveLength(2);
  });
});
