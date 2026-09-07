/**
 * В исходниках не должно быть сырого нулевого байта (v4.32.619).
 *
 * Это не про поведение — про возможность проверить поведение. Нулевой байт
 * внутри строкового литерала работает как надо, но `grep`, `ripgrep` и `git
 * grep` считают такой файл двоичным и молча не находят в нём НИЧЕГО: не «нет
 * совпадений», а «файл пропущен». Проверка исходника грепом по такому файлу
 * даёт ложный отрицательный ответ, и на этом уже спотыкался разбор:
 * `groupBackup.ts` (нулевой байт в разделителе ключа) выглядел файлом, в
 * котором нет объявленных в нём же функций.
 *
 * Домашнее написание — экранированное, `\u0000`; в строке и шаблоне оно
 * означает ровно тот же байт (см. liveAccountSync.ts, где разделитель ключа
 * комментария всегда писался так).
 */
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.join(__dirname, '..', '..');

function walk(dir: string, out: string[] = []): string[] {
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    if (fs.statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

describe('исходники остаются доступны для поиска', () => {
  const files = walk(ROOT);

  it('проверка не пустая: обход находит исходники', () => {
    expect(files.length).toBeGreaterThan(200);
    expect(files.some((f) => f.endsWith(path.join('storage', 'groupBackup.ts')))).toBe(true);
  });

  it('ни в одном файле нет сырого нулевого байта', () => {
    const guilty = files.filter((f) => fs.readFileSync(f).includes(0));
    expect(guilty.map((f) => path.relative(ROOT, f))).toEqual([]);
  });

  it('проверка не пустая: экранированное написание нулевого байта в ходу', () => {
    // Иначе правило выше удовлетворило бы и удаление разделителя вовсе.
    const src = fs.readFileSync(path.join(ROOT, 'core', 'storage', 'groupBackup.ts'), 'utf8');
    expect(src).toContain('\\u0000');
  });
});
